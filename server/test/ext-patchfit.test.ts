import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AePatchColorMatchSchema,
  AePatchFinishSchema,
  AePatchGrainSchema,
  blurLengthPx,
  buildCurves,
  buildKeys,
  COLOR_EFFECT_NAME,
  colorMismatches,
  decimateKeys,
  evalLevels,
  ENCODED_TO_LINEAR_EXPONENT,
  exposureFromGainOffset,
  exposureLinearFromGainOffset,
  featherFor,
  fillGaps,
  finishMismatches,
  fitFrame,
  grainIntensityFor,
  grainMismatches,
  levelsFromGainOffset,
  makeRingSet,
  nextGrainIntensity,
  ownEffectIndex,
  patchfitTools,
  pickVerifyTimes,
  planFrameTimes,
  regionSpeeds,
  seamColour,
  sigmaForEnergy,
  smoothGaussian,
  spreadFrames,
  valueAtLinear,
  warpGrayToRef,
  warpRgbaToRef,
  type FinishPlan,
  type FrameFit,
} from "../src/tools/ext/patchfit.js";
import { loadTrack, saveTrack } from "../src/tools/ext/planar.js";
import type { Mat3, PlanarTrack } from "../src/tools/ext/planar-math.js";
import type { Pt } from "../src/tools/ext/region-math.js";
import { toGray } from "../src/tools/ext/track.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

// The track store, the chunk state and the frame folder live under the data dir: keep them out of the real one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-patchfit-"));
const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
beforeAll(() => {
  process.env.LOCALAPPDATA = dataDir;
  process.env.HOME = dataDir;
  process.env.XDG_DATA_HOME = dataDir;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Each tool test renders and measures real PNGs: give them room on a slow machine.
vi.setConfig({ testTimeout: 60000 });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => patchfitTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
type Out = Record<string, any>;
const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// ---------- pure: sampling and series ----------

describe("sampling", () => {
  it("plans the first frame, every Nth, the last and the reference", () => {
    const p = planFrameTimes({ fps: 10, duration: 2, workStart: 0, workDuration: 2, step: 5, refTime: 0.7 });
    expect(p.times).toEqual([0, 0.5, 0.7, 1, 1.5, 1.9]);
    expect(p.total_frames).toBe(20);
    expect(p.ref_time).toBeCloseTo(0.7);
  });

  it("refuses more than 3000 frames", () => {
    expect(() => planFrameTimes({ fps: 25, duration: 400, workStart: 0, workDuration: 400, step: 1 })).toThrow(/3000/);
    expect(planFrameTimes({ fps: 25, duration: 400, workStart: 0, workDuration: 400, step: 4 }).times.length).toBeLessThanOrEqual(3000);
  });

  it("spreads frames over a range, never repeating one", () => {
    expect(spreadFrames(0, 9, 3)).toEqual([0, 5, 9]);
    expect(spreadFrames(4, 4, 3)).toEqual([4]);
    expect(spreadFrames(0, 9, 1)).toEqual([5]);
  });
});

describe("series", () => {
  it("fills gaps by interpolation and holds the ends", () => {
    expect(fillGaps([null, 1, null, null, 4, null])).toEqual([1, 1, 2, 3, 4, 4]);
    expect(fillGaps([null, null])).toBeNull();
  });

  it("smooths without moving a constant or a linear ramp in the middle", () => {
    expect(smoothGaussian([2, 2, 2, 2, 2], 2)).toEqual([2, 2, 2, 2, 2]);
    const ramp = Array.from({ length: 21 }, (_, i) => i);
    near(smoothGaussian(ramp, 2)[10], 10, 1e-6);
    expect(smoothGaussian([1, 5, 1], 0)).toEqual([1, 5, 1]);
  });

  it("thins to the keys linear interpolation needs", () => {
    const times = Array.from({ length: 50 }, (_, i) => i / 10);
    const line = times.map((t) => 1 + 0.1 * t);
    expect(decimateKeys(times, [line], [0.002])).toEqual([0, 49]);
    const bend = times.map((t) => (t < 2.5 ? 1 : 1 + 0.2 * (t - 2.5)));
    const kept = decimateKeys(times, [bend], [0.002]);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    // Interpolating the kept keys misses nothing by more than the tolerance.
    for (let i = 0; i < times.length; i++) {
      const v = valueAtLinear(kept.map((k) => times[k]), kept.map((k) => bend[k]), times[i]);
      expect(Math.abs(v - bend[i])).toBeLessThanOrEqual(0.0021);
    }
  });

  it("reads a keyed series linearly with the ends held", () => {
    expect(valueAtLinear([0, 1], [0, 10], 0.25)).toBeCloseTo(2.5);
    expect(valueAtLinear([0, 1], [0, 10], -3)).toBe(0);
    expect(valueAtLinear([0, 1], [0, 10], 3)).toBe(10);
  });

  it("picks the reference, the worst frames and an even spread to verify on", () => {
    const times = Array.from({ length: 20 }, (_, i) => i / 10);
    const dev = times.map((_, i) => (i === 13 ? 9 : i === 4 ? 5 : 0));
    const picked = pickVerifyTimes(times, dev, 0.2, 8);
    expect(picked.length).toBe(8);
    expect(picked).toContain(0.2);
    expect(picked).toContain(1.3);
    expect(picked).toContain(0.4);
  });
});

describe("the correction as effect values", () => {
  it("maps the common case to Output Black = offset and Output White = offset + gain", () => {
    const l = levelsFromGainOffset(0.8, 0.1);
    expect(l).toMatchObject({ inBlack: 0, inWhite: 1, clamped: false });
    near(l.outBlack, 0.1, 1e-9);
    near(l.outWhite, 0.9, 1e-9);
  });

  it("keeps the mapping exact when the line leaves the unit square", () => {
    for (const [g, o] of [
      [1.3, 0.05],
      [1.3, -0.1],
      [0.8, 0.3],
      [2, -0.4],
      [1, 0.1],
      [1, -0.1],
    ] as Array<[number, number]>) {
      const l = levelsFromGainOffset(g, o);
      for (const x of [0, 0.1, 0.3, 0.5, 0.8, 1]) {
        const want = Math.min(1, Math.max(0, o + g * x));
        near(evalLevels(l, x), want, 1e-9);
      }
    }
  });

  it("clamps what Levels cannot show and says so", () => {
    expect(levelsFromGainOffset(100, 0).clamped).toBe(true);
    expect(levelsFromGainOffset(1, 2).clamped).toBe(true);
    expect(levelsFromGainOffset(1, 0).clamped).toBe(false);
  });

  it("gives Exposure in stops with the offset kept", () => {
    const e = exposureFromGainOffset(2, 0.02);
    near(e.exposure, 1, 1e-9);
    expect(e.offset).toBe(0.02);
    expect(exposureFromGainOffset(1, 0).exposure).toBe(0);
  });

  it("thins both the Levels and the Exposure values, and spots a shot without drift", () => {
    const times = Array.from({ length: 30 }, (_, i) => i / 10);
    const gain = [times.map((t) => 1 + 0.05 * t), times.map((t) => 1 + 0.02 * t), times.map((t) => 1 - 0.03 * t)];
    const offset = [times.map(() => 0.01), times.map(() => 0), times.map(() => -0.01)];
    const curves = { gain, offset, filled: [], usable: 30 };
    const lv = buildKeys(times, curves, "levels");
    expect(lv.times.length).toBeLessThanOrEqual(4);
    expect(Object.keys(lv.series.red)).toEqual(["in_black", "in_white", "out_black", "out_white"]);
    const ex = buildKeys(times, curves, "exposure");
    expect(Object.keys(ex.series.green)).toEqual(["exposure", "offset"]);
    expect(lv.noDrift).toBe(false);
    const flat = { gain: [0, 1, 2].map(() => times.map(() => 1)), offset: [0, 1, 2].map(() => times.map(() => 0)), filled: [], usable: 30 };
    const none = buildKeys(times, flat, "levels");
    expect(none.noDrift).toBe(true);
    expect(none.constant).toBe(true);
    expect(none.times).toEqual([0]);
  });
});

// ---------- pure: the ring fit ----------

const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const hashUnit = (...n: number[]) => {
  let h = 2166136261;
  for (const v of n) {
    h ^= v + 0x9e3779b9;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
const randn = (...n: number[]) => Math.sqrt(-2 * Math.log(Math.max(1e-12, hashUnit(...n, 1)))) * Math.cos(2 * Math.PI * hashUnit(...n, 2));

const W = 240;
const H = 160;
const FPS = 10;
const COPY_ID = 900;
const REGION = { kind: "rect", rect: [100, 60, 140, 100] } as const;
const POLY: Pt[] = [
  [100, 60],
  [140, 60],
  [140, 100],
  [100, 100],
];

const tex = (x: number, y: number, c: number) => 120 + 30 * Math.sin(0.31 * x + c) * Math.cos(0.27 * y) + 20 * Math.sin(0.11 * x + 0.17 * y + c) + 15 * Math.sin(0.53 * x - 0.41 * y);
const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function image(w: number, h: number, f: (x: number, y: number, c: number) => number) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) data[(y * w + x) * 4 + c] = clamp255(f(x, y, c));
      data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const translate = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];

describe("the ring fit", () => {
  const ref = image(W, H, (x, y, c) => tex(x, y, c));
  const ring = makeRingSet(W, H, POLY, 2, 14);

  it("recovers a known gain and offset per channel", () => {
    const g = [1.15, 0.9, 1.05];
    const o = [0.02, -0.03, 0.01];
    const frame = image(W, H, (x, y, c) => g[c] * tex(x, y, c) + o[c] * 255);
    const fit = fitFrame(ref, frame, ring, translate(0, 0), 1, { minVisible: 0.4 });
    expect(fit.ok).toBe(true);
    for (let c = 0; c < 3; c++) {
      near(fit.gain[c], g[c], 0.01);
      near(fit.offset[c], o[c], 0.01);
    }
    expect(fit.visible).toBe(1);
  });

  it("lines the ring up through the track before it fits", () => {
    const g = [1.1, 1.1, 1.1];
    const frame = image(W, H, (x, y, c) => g[c] * tex(x - 7, y + 3, c));
    const aligned = fitFrame(ref, frame, ring, translate(7, -3), 1, { minVisible: 0.4 });
    near(aligned.gain[0], 1.1, 0.01);
    const blind = fitFrame(ref, frame, ring, translate(0, 0), 1, { minVisible: 0.4 });
    expect(Math.abs(blind.gain[0] - 1.1)).toBeGreaterThan(0.1);
  });

  it("fits through a half-size render with the scale given", () => {
    const half = image(W / 2, H / 2, (x, y, c) => 1.2 * tex(x * 2 + 0.5, y * 2 + 0.5, c));
    const halfRef = image(W / 2, H / 2, (x, y, c) => tex(x * 2 + 0.5, y * 2 + 0.5, c));
    const halfRing = makeRingSet(W / 2, H / 2, POLY.map((p) => [p[0] / 2, p[1] / 2] as Pt), 1, 7);
    const fit = fitFrame(halfRef, half, halfRing, translate(0, 0), 0.5, { minVisible: 0.4 });
    near(fit.gain[1], 1.2, 0.02);
  });

  it("shrugs off a person walking through the ring (trimmed fit)", () => {
    const frame = image(W, H, (x, y, c) => {
      const v = 1.1 * tex(x, y, c);
      return x >= 142 && x < 146 && y >= 70 && y < 90 ? 250 : v;
    });
    const fit = fitFrame(ref, frame, ring, translate(0, 0), 1, { minVisible: 0.4 });
    near(fit.gain[0], 1.1, 0.03);
  });

  it("gives no fit where the ring is out of view, the track lost the plate or the pixels are clipped", () => {
    const frame = image(W, H, (x, y, c) => tex(x, y, c));
    const out = fitFrame(ref, frame, ring, translate(150, 0), 1, { minVisible: 0.4 });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/in view/);
    expect(fitFrame(ref, frame, ring, null, 1, { minVisible: 0.4 }).reason).toMatch(/track lost/);
    const white = image(W, H, () => 255);
    expect(fitFrame(white, white, ring, translate(0, 0), 1, { minVisible: 0.4 }).ok).toBe(false);
  });

  it("warps colour and gray through the same lookup", () => {
    const shifted = image(W, H, (x, y, c) => tex(x - 5, y, c));
    const w = warpRgbaToRef(shifted, translate(5, 0), 1, ring);
    const k = ring.idx[10];
    expect(w.img.data[k * 4]).toBe(ref.data[k * 4]);
    const g = warpGrayToRef(toGray(shifted), translate(5, 0), 1, ring);
    near(g.gray.data[k], toGray(ref).data[k], 1);
    expect(g.validCount).toBe(ring.idx.length);
  });

  it("builds smoothed curves and skips the unmeasured frames", () => {
    const fit = (g: number): FrameFit => ({ ok: true, gain: [g, g, g], offset: [0, 0, 0], rms: 0, pixels: 100, visible: 1 });
    const bad: FrameFit = { ok: false, reason: "x", gain: [1, 1, 1], offset: [0, 0, 0], rms: 0, pixels: 0, visible: 0 };
    const curves = buildCurves([fit(1), fit(1.1), bad, fit(1.3), fit(1.4)], { smoothFrames: 0, step: 1 })!;
    expect(curves.filled).toEqual([2]);
    near(curves.gain[0][2], 1.2, 1e-9);
    expect(buildCurves([fit(1), bad, bad], { smoothFrames: 3, step: 1 })).toBeNull();
  });

  it("measures the colour step across the seam", () => {
    const patch = image(W, H, (x, y, c) => (x >= 100 && x < 140 && y >= 60 && y < 100 ? 140 : 100) + c * 0);
    const s = seamColour(patch, POLY, 2, 12)!;
    near(s.mean_abs, 40 / 255, 0.01);
    const flat = image(W, H, () => 100);
    expect(seamColour(flat, POLY, 2, 12)!.mean_abs).toBe(0);
  });
});

// ---------- pure: grain, sharpness, motion blur, edge ----------

describe("grain, sharpness, motion blur and edge helpers", () => {
  it("scales Add Grain intensity by the measured ratio, within a cap", () => {
    expect(grainIntensityFor(4)).toBeCloseTo(0.2);
    expect(grainIntensityFor(0.1)).toBe(0.02);
    expect(nextGrainIntensity(0.2, 8, 4)).toBeCloseTo(0.1);
    expect(nextGrainIntensity(0.2, 0.5, 4)).toBeCloseTo(0.8);
    expect(nextGrainIntensity(0.2, 0, 4)).toBeCloseTo(0.8);
  });

  it("finds the blur that brings a sharp region to a target detail", () => {
    const sharp = { width: 60, height: 60, data: Float32Array.from({ length: 3600 }, (_, i) => 128 + 60 * Math.sin(((i % 60) * 1.3) + Math.floor(i / 60) * 0.9)) };
    const mask = new Float32Array(3600).fill(1);
    const blurred = sigmaForEnergy(sharp, mask, 20, 4);
    expect(blurred).toBeGreaterThan(0);
    expect(blurred).toBeLessThan(4);
    expect(sigmaForEnergy(sharp, mask, 1e9, 4)).toBe(0);
    expect(sigmaForEnergy(sharp, mask, 0.0001, 4)).toBe(4);
  });

  it("turns speed and shutter into blur length", () => {
    expect(blurLengthPx(10, 180)).toBe(5);
    expect(blurLengthPx(10, 360)).toBe(10);
    expect(blurLengthPx(0, 180)).toBe(0);
  });

  it("raises the feather with the seam score and keeps expansion at half of it", () => {
    const f = featherFor(2.5, 1.5, 0, 0, 40);
    expect(f.feather).toBe(5);
    expect(f.expansion).toBe(2.5);
    expect(featherFor(50, 1.5, 0, 10, 12)).toEqual({ feather: 12, expansion: 10 });
  });

  it("measures the speed of the region through a track", () => {
    const frames = Array.from({ length: 6 }, (_, k) => ({ time: k / 10, ok: true, H: translate(3 * k, 4 * k), points: [], confidence: [], rms_px: 0, inliers: 1 }));
    const track = { version: 1, track_id: "t", comp_id: 1, comp_size: [W, H], fps: 10, ref_time: 0, model: "translate", ref_points: [], frames, source: "test", created: "" } as unknown as PlanarTrack;
    expect(regionSpeeds(POLY, track, 10, 0, 5)).toEqual([5, 5, 5, 5, 5]);
    expect(regionSpeeds(POLY, null, 10, 0, 5)).toEqual([]);
  });
});

// ---------- schemas ----------

describe("schemas", () => {
  const base = { comp_id: 1, layer: { id: 100 }, region: REGION, expect: expectArg };

  it("takes defaults for ae_patch_color_match and needs layer and region unless continuing", () => {
    const a = AePatchColorMatchSchema.parse(base);
    expect(a).toMatchObject({ step: 1, ring_px: 12, smooth_frames: 3, effect: "levels", dry_run: false, verify: true, max_renders: 150, max_seconds: 90 });
    expect(AePatchColorMatchSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
    expect(AePatchColorMatchSchema.safeParse({ comp_id: 1, continue_id: "pfc_x", expect: expectArg }).success).toBe(true);
    expect(AePatchColorMatchSchema.safeParse({ ...base, effect: "curves" }).success).toBe(false);
    expect(AePatchColorMatchSchema.safeParse({ ...base, step: 0 }).success).toBe(false);
    expect(AePatchColorMatchSchema.safeParse({ ...base, expect: undefined }).success).toBe(false);
    expect(AePatchColorMatchSchema.safeParse({ ...base, track: { track_id: "a", nulls: [{ index: 1 }] } }).success).toBe(false);
  });

  it("takes defaults for ae_patch_grain and needs plate_layer for match", () => {
    const a = AePatchGrainSchema.parse(base);
    expect(a).toMatchObject({ method: "add", degrain: "none", rounds: 2, samples: 3, tolerance: 0.1, min_sigma: 0.6 });
    expect(AePatchGrainSchema.safeParse({ ...base, method: "match" }).success).toBe(false);
    expect(AePatchGrainSchema.safeParse({ ...base, method: "match", plate_layer: { index: 2 } }).success).toBe(true);
    expect(AePatchGrainSchema.safeParse({ ...base, rounds: 4 }).success).toBe(false);
    expect(AePatchGrainSchema.safeParse({ ...base, degrain: "blur" }).success).toBe(false);
  });

  it("takes defaults for ae_patch_finish", () => {
    const a = AePatchFinishSchema.parse(base);
    expect(a).toMatchObject({ sharpness: true, edge: true, motion_blur: true, quality: true, seam_max: 1.5, max_feather: 40, allow_comp_change: false, samples: 5 });
    expect(AePatchFinishSchema.safeParse({ ...base, shutter_angle: 900 }).success).toBe(false);
  });

  it("ends every tool description with the safety guidance and declares expect", () => {
    expect(patchfitTools.map((t) => t.name)).toEqual(["ae_patch_color_match", "ae_patch_grain", "ae_patch_finish"]);
    for (const t of patchfitTools) {
      expect(t.description).toMatch(/Always re-read project\/comp state before writing/);
      expect(t.description.trim().endsWith("retry with stale expectations.")).toBe(true);
      expect(t.schema.safeParse({ comp_id: 1, layer: { id: 1 }, region: REGION, continue_id: "x" }).success).toBe(false);
    }
  });
});

// ---------- a fake AE that renders ----------

interface Scene {
  /** The plate at frame k, comp pixel (x, y), channel c: 0..255 (floats are rounded). */
  plate(k: number, x: number, y: number, c: number): number;
  /** The patch's pixels at frame k inside the region (before any correction); null keeps the plate. */
  patch?(k: number, x: number, y: number, c: number): number | null;
}

interface AeOpts {
  scene: Scene;
  /** Size of the renders relative to the comp (the snapshots are half size in real life). */
  renderScale?: number;
  info?: Record<string, any>;
  levelsScale?: number;
  noEffectAfter?: boolean;
  failApply?: boolean;
  failState?: boolean;
  channelsValue?: number;
  /** An earlier sit-in blur on the patch: its Blurriness at the reference frame. */
  oldBlur?: { value: number };
  bypassValue?: number;
  /** Host functions that throw when called (a guard mismatch, a host refusal). */
  failFns?: string[];
  /** The patch layer's state in the grain read-back. */
  patchState?: Record<string, unknown>;
  pixelAspect?: number;
  /** Called after every snapshot render. */
  onSnap?: (phase: "before" | "after") => void;
  /** Renders of this comp time fail (a plain error) this many times before they work. */
  failSnap?: { time: number; times: number };
}

const inRegion = (x: number, y: number) => x >= 100 && x < 140 && y >= 60 && y < 100;

function hostInfo(over: Record<string, any> = {}, pixelAspect = 1) {
  const o = over;
  return {
    comp: {
      id: 1,
      name: "Main",
      width: W,
      height: H,
      pixel_aspect: pixelAspect,
      fps: FPS,
      frame_duration: 0.1,
      duration: 1,
      time: 0,
      work_area_start: 0,
      work_area_duration: 1,
      shutter_angle: 180,
      shutter_phase: -90,
      motion_blur: false,
      bits_per_channel: 8,
      linear_blending: false,
      working_space: "sRGB",
      linearize_working_space: false,
      ...(o.comp ?? {}),
    },
    layer: {
      index: 1,
      id: 100,
      name: "Patch",
      locked: false,
      enabled: true,
      has_video: true,
      three_d: false,
      in_point: 0,
      out_point: 1,
      motion_blur: false,
      sampling_bicubic: false,
      frame_blend_none: false,
      quality_best: false,
      effects: [],
      masks: [],
      pinned: false,
      ...(o.layer ?? {}),
    },
    hidden: [],
    show: [{ index: 2, id: 101 }],
    total_layers: 2,
  };
}

interface Applied {
  mode: "levels" | "exposure";
  bypass?: boolean;
  times: number[];
  series: Record<string, Record<string, number[]>>;
}

function fakeAe(opts: AeOpts) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-patchfit-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const scale = opts.renderScale ?? 1;
  const state: { color: Applied | null; grain: { intensity: number; viewing: number; degrain: string } | null; finish: any } = { color: null, grain: null, finish: null };
  const info = () => hostInfo(opts.info, opts.pixelAspect ?? 1);
  const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
  const seriesAt = (t: number, ch: string, role: string) => {
    const a = state.color as Applied;
    return valueAtLinear(a.times, a.series[ch][role], t);
  };

  const patchValue = (k: number, t: number, x: number, y: number, c: number): number | null => {
    const raw = opts.scene.patch ? opts.scene.patch(k, x, y, c) : null;
    if (raw === null) return null;
    if (state.color) {
      const ch = ["red", "green", "blue"][c];
      const v = raw / 255;
      if (state.color.mode === "levels") {
        const p = { inBlack: seriesAt(t, ch, "in_black"), inWhite: seriesAt(t, ch, "in_white"), outBlack: seriesAt(t, ch, "out_black"), outWhite: seriesAt(t, ch, "out_white"), clamped: false };
        return evalLevels(p, v) * 255;
      }
      return (v * Math.pow(2, seriesAt(t, ch, "exposure")) + seriesAt(t, ch, "offset")) * 255;
    }
    if (state.grain) return raw + state.grain.intensity * 30 * randn(k, Math.round(x), Math.round(y), c, 77);
    return raw;
  };

  const render = (compId: number, time: number) => {
    const k = Math.round(time * FPS);
    const w = Math.round(W * scale);
    const h = Math.round(H * scale);
    const t = k / FPS;
    return image(w, h, (px, py, c) => {
      const x = (px + 0.5) / scale - 0.5;
      const y = (py + 0.5) / scale - 0.5;
      if (compId !== COPY_ID && inRegion(x + 0.5, y + 0.5)) {
        const v = patchValue(k, t, x, y, c);
        if (v !== null) return v;
      }
      return opts.scene.plate(k, x, y, c);
    });
  };

  const effectState = (args: any) => {
    const a = state.color;
    const base = { layer: { index: 1, id: 100, name: "Patch" } };
    if (opts.failState && a) throw new Error("the read-back failed");
    if (!a || opts.noEffectAfter) return { ...base, effects: [], effect: null };
    const labels: Record<string, string> = { red: "Red", green: "Green", blue: "Blue" };
    const suffix: Record<string, string> = { in_black: "Input Black", in_white: "Input White", out_black: "Output Black", out_white: "Output White", exposure: "Exposure", offset: "Offset" };
    const sc = a.mode === "levels" ? (opts.levelsScale ?? 1) : 1;
    const params: any[] = [];
    let i = 1;
    for (const ch of ["red", "green", "blue"]) {
      for (const role of Object.keys(a.series[ch])) {
        const series = a.series[ch][role];
        params.push({
          index: i++,
          name: `${labels[ch]} ${suffix[role]}`,
          matchName: "",
          type: "1d",
          num_keys: a.times.length > 1 ? a.times.length : 0,
          expression: false,
          value: series[0] * sc,
          samples: (args.times ?? []).map((t: number) => ({ time: t, value: valueAtLinear(a.times, series, t) * sc })),
        });
      }
    }
    if (a.mode === "exposure") {
      params.push(
        { index: i++, name: "Channels", matchName: "", type: "1d", num_keys: 0, expression: false, value: opts.channelsValue ?? 2, samples: [] },
        { index: i++, name: "Bypass Linear Light Conversion", matchName: "", type: "1d", num_keys: 0, expression: false, value: opts.bypassValue ?? (a.bypass === false ? 0 : 1), samples: [] }
      );
    }
    const brief = { index: 1, name: COLOR_EFFECT_NAME, matchName: a.mode === "levels" ? "ADBE Pro Levels2" : "ADBE Exposure2" };
    return { ...base, effects: [brief], effect: { ...brief, params } };
  };

  const grainState = () => {
    const g = state.grain;
    const basePatch = { index: 2, id: 100, name: "Patch", enabled: true, in_point: 0, out_point: 1 };
    const patch = g ? { ...basePatch, ...(opts.patchState ?? {}) } : basePatch;
    if (!g) return { patch, patch_effects: [], adjustment: null, matte: null, effect: null };
    return {
      patch,
      patch_effects: g.degrain === "none" ? [] : [{ index: 1, name: "Chroma degrain", matchName: "ADBE Median" }],
      adjustment: { index: 1, id: 200, name: "Patch GRAIN", adjustment_layer: true, above_patch: true, in_point: 0, out_point: 1 },
      matte: { type: 5013, layer_id: 100, alpha: true },
      effect: {
        index: 1,
        name: "Chroma grain",
        matchName: "VISINF Grain Implant",
        params: [
          { index: 2, name: "Viewing Mode", matchName: "", type: "1d", num_keys: 0, expression: false, value: g.viewing, samples: [] },
          { index: 3, name: "Intensity", matchName: "", type: "1d", num_keys: 0, expression: false, value: g.intensity, samples: [] },
        ],
      },
    };
  };

  const finishState = () => {
    const f = state.finish;
    const lay = info().layer as any;
    const masks = (lay.masks as any[]).map((m) => {
      const done = f?.edge ? (f.edge.masks as any[]).find((x) => x.index === m.index) : null;
      return done ? { ...m, feather: [done.feather, done.feather], expansion: done.expansion } : m;
    });
    const earlier = (opts.oldBlur ?? null) as { value: number } | null;
    const blur = !f?.blur && earlier
      ? { index: 1, name: "Chroma sit-in blur", matchName: "ADBE Gaussian Blur 2", params: [{ index: 1, name: "Blurriness", matchName: "", type: "1d", num_keys: 0, expression: false, value: earlier.value, samples: [{ time: 0, value: earlier.value }] }] }
      : f?.blur
      ? {
          index: 1,
          name: "Chroma sit-in blur",
          matchName: "ADBE Gaussian Blur 2",
          params: [
            {
              index: 1,
              name: "Blurriness",
              matchName: "",
              type: "1d",
              num_keys: f.blur.times.length > 1 ? f.blur.times.length : 0,
              expression: false,
              value: f.blur.values[0],
              samples: (f.times ?? []).map((t: number) => ({ time: t, value: valueAtLinear(f.blur.times, f.blur.values, t) })),
            },
          ],
        }
      : null;
    return {
      comp: { ...info().comp, motion_blur: f?.comp?.motion_blur ?? info().comp.motion_blur },
      layer: {
        ...lay,
        masks,
        motion_blur: f?.layer_switches?.motion_blur ?? lay.motion_blur,
        sampling_bicubic: f?.layer_switches?.sampling_bicubic ?? lay.sampling_bicubic,
        frame_blend_none: f?.layer_switches?.frame_blend_none ?? lay.frame_blend_none,
        quality_best: f?.layer_switches?.quality_best ?? lay.quality_best,
      },
      blur,
      force_motion_blur: f?.force_motion_blur ? { index: 2 } : null,
    };
  };

  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (opts.failFns?.includes(fn) && fn !== "checkGuard") throw new Error(`${fn} refused by the host`);
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "patchfitInfo") return ok(info());
      if (fn === "planarIsolateBegin") return ok({ copy_id: COPY_ID, copy_name: "_chroma_plate_Main", original_id: 1 });
      if (fn === "planarIsolateEnd") return ok({ removed: true, copy_id: COPY_ID });
      if (fn === "snapshotFrame") {
        if (opts.failSnap && Math.abs(args.time - opts.failSnap.time) < 1e-6 && opts.failSnap.times > 0) {
          opts.failSnap.times--;
          throw new Error("render glitch");
        }
        opts.onSnap?.("before");
        fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
        fs.writeFileSync(args.output_path, PNG.sync.write(Object.assign(new PNG({ width: 1, height: 1 }), render(args.comp_id, args.time))));
        opts.onSnap?.("after");
        return ok({ path: args.output_path, time: args.time });
      }
      if (fn === "patchfitColorApply") {
        if (opts.failApply) throw new Error("Layer is locked");
        state.color = { mode: args.mode, bypass: args.bypass_linear, times: args.times, series: args.series };
        return ok({
          layer: { index: 1, id: 100, name: "Patch" },
          effect: { index: 1, name: COLOR_EFFECT_NAME, matchName: "x" },
          mode: args.mode,
          scale: opts.levelsScale ?? 1,
          table: [],
          keys: args.times.length,
          slot: { wanted: 1, moved: false },
          replaced: false,
          clamped: [],
          channels_written: args.mode === "exposure" ? 2 : null,
          bypass_written: args.mode === "exposure" ? (args.bypass_linear === false ? 0 : 1) : null,
          notes: [],
        });
      }
      if (fn === "patchfitEffectState") return ok(effectState(args));
      if (fn === "patchfitGrainApply") {
        state.grain = { intensity: args.intensity, viewing: args.viewing_mode_index ?? 3, degrain: args.degrain };
        return ok({
          patch: { index: 2, id: 100, name: "Patch" },
          degrain: args.degrain === "none" ? null : { index: 1, name: "Chroma degrain" },
          adjustment: { index: 1, id: 200, name: "Patch GRAIN" },
          grain: { index: 1, name: "Chroma grain", matchName: "VISINF Grain Implant", table: [], viewing_mode_index: args.viewing_mode_index ?? 3 },
          api: "setTrackMatte",
          notes: [],
        });
      }
      if (fn === "patchfitGrainTune") {
        const before = (state.grain as { intensity: number }).intensity;
        (state.grain as { intensity: number }).intensity = args.intensity;
        return ok({ layer: { index: 1, id: 200, name: "Patch GRAIN" }, effect_index: 1, intensity_before: before, intensity: args.intensity, notes: [] });
      }
      if (fn === "patchfitGrainState") return ok(grainState());
      if (fn === "patchfitFinishApply") {
        state.finish = { ...args, times: args.blur?.times ?? [] };
        return ok({
          layer: { index: 1, id: 100, name: "Patch" },
          blur: args.blur ? { index: 1, name: "Chroma sit-in blur" } : null,
          edge: args.edge ? { masks: args.edge.masks, skipped: [] } : null,
          layer_switches: args.layer_switches ?? null,
          comp: args.comp ?? null,
          force_motion_blur: args.force_motion_blur ? { index: 2 } : null,
          notes: [],
        });
      }
      if (fn === "patchfitFinishState") return ok(finishState());
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn), state };
}

// The shot drifts: gain and offset change per frame; the patch holds frame 0.
const GAIN = (k: number) => [1 + 0.02 * k, 1 + 0.01 * k, 1 - 0.01 * k];
const OFF = (k: number) => [0, (0.01 * k) / 9, (-0.01 * k) / 9];

const driftScene = (shift: (k: number) => number = () => 0): Scene => ({
  plate: (k, x, y, c) => GAIN(k)[c] * tex(x - shift(k), y, c) + OFF(k)[c] * 255,
  patch: (_k, x, y, c) => tex(x, y, c),
});

const colorArgs = (extra: Record<string, unknown> = {}) => AePatchColorMatchSchema.parse({ comp_id: 1, layer: { id: 100 }, region: REGION, smooth_frames: 0, expect: expectArg, ...extra });

// ---------- ae_patch_color_match ----------

describe("ae_patch_color_match", () => {
  it("measures the drift per channel on a locked-off shot, writing nothing on dry_run", async () => {
    const ae = fakeAe({ scene: driftScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.complete).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.curves.samples).toHaveLength(10);
    for (const row of out.curves.samples) {
      const k = Math.round(row.time * FPS);
      for (let c = 0; c < 3; c++) {
        near(row.gain[c], GAIN(k)[c], 0.012);
        near(row.offset[c], OFF(k)[c], 0.012);
      }
    }
    expect(out.drift.no_drift).toBe(false);
    expect(out.drift.flicker_luma_swing).toBeGreaterThan(0.02);
    expect(out.graph_path).toMatch(/patchfit_gain/);
    expect(fs.existsSync(out.graph_path)).toBe(true);
    // Nothing was written to the patch; the plate comp was made and removed again.
    expect(ae.fns()).not.toContain("patchfitColorApply");
    expect(ae.fns().filter((f) => f === "planarIsolateBegin")).toHaveLength(1);
    expect(ae.fns().filter((f) => f === "planarIsolateEnd")).toHaveLength(1);
    expect(out.temp_comp).toMatchObject({ copy_removed: true });
    expect(out.receipt.matches).toBe(true);
    expect(out.project).toMatchObject({ bits_per_channel: 8, linear_blending: false });
  });

  it("follows a moving shot through the track", async () => {
    const frames = Array.from({ length: 10 }, (_, k) => ({ time: k / FPS, ok: true, H: translate(2 * k, k), points: [], confidence: [], rms_px: 0, inliers: 1 }));
    const track: PlanarTrack = { version: 1, track_id: "trk_pf_move", comp_id: 1, comp_size: [W, H], fps: FPS, ref_time: 0, model: "translate", ref_points: [[0, 0]], frames, source: "test", created: "" } as PlanarTrack;
    saveTrack(track);
    const scene: Scene = {
      plate: (k, x, y, c) => GAIN(k)[c] * tex(x - 2 * k, y - k, c) + OFF(k)[c] * 255,
      patch: (_k, x, y, c) => tex(x, y, c),
    };
    const ae = fakeAe({ scene });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, track: { track_id: "trk_pf_move" } }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    for (const row of out.curves.samples) {
      const k = Math.round(row.time * FPS);
      near(row.gain[0], GAIN(k)[0], 0.015);
      near(row.gain[2], GAIN(k)[2], 0.015);
    }
    // The same shot without the track does not line up.
    const blind = fakeAe({ scene });
    const wrong = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true }), blind.ctx)) as Out;
    const last = wrong.curves.samples[wrong.curves.samples.length - 1];
    expect(Math.abs(last.gain[0] - GAIN(9)[0])).toBeGreaterThan(0.02);
  });

  it("works on half-size renders", async () => {
    const ae = fakeAe({ scene: driftScene(), renderScale: 0.5 });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, step: 3 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    const last = out.curves.samples[out.curves.samples.length - 1];
    near(last.gain[0], GAIN(9)[0], 0.03);
  });

  it("writes Levels keys in one guarded undo step, reads them back separately, and the seam improves", async () => {
    const ae = fakeAe({ scene: driftScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ step: 1 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.write.applied).toBe(true);
    expect(out.write.receipt.matches).toBe(true);
    expect(out.write.receipt.mismatches).toEqual([]);
    const fns = ae.fns();
    const iApply = fns.indexOf("patchfitColorApply");
    // The read-back comes from a separate call after the write, and the guard before it.
    expect(fns.slice(iApply - 2, iApply + 2)).toEqual(["checkGuard", "patchfitEffectState", "patchfitColorApply", "patchfitEffectState"]);
    expect(fns.indexOf("planarIsolateEnd")).toBeLessThan(fns.indexOf("checkGuard", fns.indexOf("planarIsolateEnd")));
    const apply = ae.calls[iApply].args;
    expect(apply).toMatchObject({ mode: "levels", replace_existing: false, layer: { id: 100 } });
    expect(apply.expect).toMatchObject({ project_path: "<unsaved>", comp_id: 1 });
    expect(apply.times.length).toBeLessThanOrEqual(10);
    expect(Object.keys(apply.series.red)).toEqual(["in_black", "in_white", "out_black", "out_white"]);
    // The seam colour difference falls after the correction.
    expect(out.verify.mean_seam_difference_before).toBeGreaterThan(0.02);
    expect(out.verify.mean_seam_difference_after).toBeLessThan(out.verify.mean_seam_difference_before);
    expect(out.verify.improved).toBe(true);
    expect(out.verify.frames.length).toBeLessThanOrEqual(8);
  });

  it("keys Exposure in stops and checks Levels units from the host's scale", async () => {
    const exp = fakeAe({ scene: driftScene() });
    const e = (await tool("ae_patch_color_match").handler(colorArgs({ effect: "exposure" }), exp.ctx)) as Out;
    expect(e.write.receipt.matches).toBe(true);
    expect(exp.calls.find((c) => c.fn === "patchfitColorApply")!.args.series.red).toHaveProperty("exposure");
    const big = fakeAe({ scene: driftScene(), levelsScale: 255 });
    const l = (await tool("ae_patch_color_match").handler(colorArgs({ verify: false }), big.ctx)) as Out;
    expect(l.write.receipt.matches).toBe(true);
    expect(l.verify).toBeUndefined();
  });

  it("flags a read-back that finds the wrong keys, and one that cannot be read", async () => {
    const wrong = fakeAe({ scene: driftScene(), noEffectAfter: true });
    const a = (await tool("ae_patch_color_match").handler(colorArgs({ verify: false }), wrong.ctx)) as Out;
    expect(a.write.applied).toBe(true);
    expect(a.write.receipt.matches).toBe(false);
    expect(a.write.receipt.mismatches.map((m: any) => m.path)).toContain("effect");
    const broken = fakeAe({ scene: driftScene(), failState: true });
    const b = (await tool("ae_patch_color_match").handler(colorArgs({ verify: false }), broken.ctx)) as Out;
    expect(b.write.applied).toBe(true);
    expect(b.write.receipt.matches).toBe(false);
    expect(b.write.receipt.mismatches[0].message).toMatch(/Do not resend/);
  });

  it("measures in chunks with continue_id and writes only on the last call", async () => {
    const ae = fakeAe({ scene: driftScene() });
    const first = (await tool("ae_patch_color_match").handler(colorArgs({ max_renders: 4 }), ae.ctx)) as Out;
    expect(first.complete).toBe(false);
    expect(first.continue_id).toMatch(/^pfc_/);
    expect(first.progress.measured).toBeLessThan(10);
    expect(ae.fns()).not.toContain("patchfitColorApply");
    let out: Out = first;
    let guard = 0;
    while (!out.complete && guard++ < 10) {
      out = (await tool("ae_patch_color_match").handler(AePatchColorMatchSchema.parse({ comp_id: 1, continue_id: out.continue_id, max_renders: 4, expect: expectArg, verify: false }), ae.ctx)) as Out;
    }
    expect(out.complete).toBe(true);
    expect(ae.fns().filter((f) => f === "patchfitColorApply")).toHaveLength(1);
    expect(out.measured.usable).toBe(10);
    // The chunks reproduce a single long call.
    const whole = fakeAe({ scene: driftScene() });
    const single = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, verify: false }), whole.ctx)) as Out;
    expect(out.curves.samples).toEqual(single.curves.samples);
  });

  it("refuses before touching the project: unknown continue id, wrong comp, locked layer, a foreign effect, pixel aspect", async () => {
    const ae = fakeAe({ scene: driftScene() });
    const h = tool("ae_patch_color_match").handler;
    expect(((await h(AePatchColorMatchSchema.parse({ comp_id: 1, continue_id: "pfc_nope", expect: expectArg }), ae.ctx)) as Out).error).toBe("not_found");
    const locked = fakeAe({ scene: driftScene(), info: { layer: { locked: true } } });
    const l = (await h(colorArgs(), locked.ctx)) as Out;
    expect(l.ok).toBe(false);
    expect(l.message).toMatch(/locked/);
    expect(locked.fns()).not.toContain("planarIsolateBegin");
    const own = fakeAe({ scene: driftScene(), info: { layer: { effects: [{ index: 1, name: COLOR_EFFECT_NAME, matchName: "ADBE Pro Levels2" }] } } });
    const o = (await h(colorArgs(), own.ctx)) as Out;
    expect(o.message).toMatch(/replace_existing/);
    expect(own.fns()).not.toContain("planarIsolateBegin");
    // dry_run does not care about either.
    const dry = (await h(colorArgs({ dry_run: true }), own.ctx)) as Out;
    expect(dry.ok).toBe(true);
    const pa = fakeAe({ scene: driftScene(), pixelAspect: 1.5 });
    expect(((await h(colorArgs(), pa.ctx)) as Out).message).toMatch(/pixel aspect/);
    const part = (await h(colorArgs({ max_renders: 4 }), fakeAe({ scene: driftScene() }).ctx)) as Out;
    const wrongComp = (await h(AePatchColorMatchSchema.parse({ comp_id: 2, continue_id: part.continue_id, expect: expectArg }), ae.ctx)) as Out;
    expect(wrongComp.error).toBe("bad_args");
  });

  it("adds no effect when the shot does not drift", async () => {
    const ae = fakeAe({ scene: { plate: (_k, x, y, c) => tex(x, y, c), patch: (_k, x, y, c) => tex(x, y, c) } });
    const out = (await tool("ae_patch_color_match").handler(colorArgs(), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.drift.no_drift).toBe(true);
    expect(out.applied).toBe(false);
    expect(ae.fns()).not.toContain("patchfitColorApply");
  });

  it("reports frames the ring is out of view, and fails clearly when none can be fitted", async () => {
    const frames = Array.from({ length: 4 }, (_, k) => ({ time: k / FPS, ok: true, H: translate(k === 0 ? 0 : 200, 0), points: [], confidence: [], rms_px: 0, inliers: 1 }));
    saveTrack({ version: 1, track_id: "trk_pf_gone", comp_id: 1, comp_size: [W, H], fps: FPS, ref_time: 0, model: "translate", ref_points: [[0, 0]], frames, source: "test", created: "" } as PlanarTrack);
    const ae = fakeAe({ scene: driftScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, start: 0, end: 0.3, track: { track_id: "trk_pf_gone" } }), ae.ctx)) as Out;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("not_measurable");
    expect(out.unmeasured.length).toBeGreaterThan(0);
    expect(out.unmeasured[0].reason).toMatch(/in view/);
  });

  it("warns for projects deeper than 8 bpc or blended in linear light", async () => {
    const ae = fakeAe({ scene: driftScene(), info: { comp: { bits_per_channel: 32, linear_blending: true } } });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true }), ae.ctx)) as Out;
    expect(out.notes.join(" ")).toMatch(/32 bpc/);
    expect(out.notes.join(" ")).toMatch(/linear light/);
  });
});

describe("colorMismatches", () => {
  const keys = { times: [0, 1], series: { red: { exposure: [0, 1], offset: [0, 0] }, green: { exposure: [0, 1], offset: [0, 0] }, blue: { exposure: [0, 1], offset: [0, 0] } }, clamped: false, constant: false, noDrift: false, linear: false, offsetDropped: false };
  const params = (numKeys: number, v1: number) => {
    const out: any[] = [];
    let i = 1;
    for (const label of ["Red", "Green", "Blue"]) {
      for (const [suffix, end] of [["Exposure", v1], ["Offset", 0]] as Array<[string, number]>) {
        out.push({ index: i++, name: `${label} ${suffix}`, matchName: "", type: "1d", num_keys: numKeys, expression: false, value: 0, samples: [{ time: 1, value: end }] });
      }
    }
    return out;
  };
  const state = (p: any[], effects = 1) => ({ layer: {}, effects: Array.from({ length: effects }, (_, i) => ({ index: i + 1, name: "x", matchName: "y" })), effect: { index: 1, name: COLOR_EFFECT_NAME, matchName: "ADBE Exposure2", params: p } });

  it("accepts the keys it wrote and names what is off", () => {
    const before = { layer: {}, effects: [], effect: null };
    expect(colorMismatches("exposure", keys, before, state(params(2, 1)), { scale: 1, slot: { wanted: 1 } })).toEqual([]);
    const bad = colorMismatches("exposure", keys, before, state(params(3, 2)), { scale: 1, slot: { wanted: 2 } });
    expect(bad.map((m) => m.path)).toEqual(expect.arrayContaining(["effect.index", "effect.red.exposure.num_keys", "effect.red.exposure@1"]));
  });
});

// ---------- ae_patch_grain ----------

const SIGMA = 5;
const grainScene = (): Scene => ({
  plate: (k, x, y, c) => tex(x, y, c) + SIGMA * randn(k, Math.round(x), Math.round(y), c, 5),
  patch: (_k, x, y, c) => tex(x, y, c),
});
const grainArgs = (extra: Record<string, unknown> = {}) => AePatchGrainSchema.parse({ comp_id: 1, layer: { id: 100 }, region: REGION, expect: expectArg, ...extra });

describe("ae_patch_grain", () => {
  it("measures the frozen-grain tell without adding anything on dry_run", async () => {
    const ae = fakeAe({ scene: grainScene() });
    const out = (await tool("ae_patch_grain").handler(grainArgs({ dry_run: true }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.sigma_before.plate_ring.spatial[0]).toBeGreaterThan(2.5);
    expect(out.sigma_before.patch.spatial[0]).toBeLessThan(1);
    expect(out.sigma_before.plate_ring.temporal).toBeGreaterThan(2.5);
    expect(out.sigma_before.patch.temporal).toBe(0);
    expect(out.sigma_before.temporal_ratio).toBeLessThan(0.2);
    expect(out.sigma_before.frozen_grain).toBe(true);
    expect(out.plan.start_intensity).toBeGreaterThan(0.1);
    expect(ae.fns()).not.toContain("patchfitGrainApply");
    expect(out.temp_comp.copy_removed).toBe(true);
  });

  it("adds matted grain from the measured sigma and tunes it until the patch matches", async () => {
    const ae = fakeAe({ scene: grainScene() });
    const out = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 3 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.grain_added).toBe(true);
    expect(out.write.receipt.matches).toBe(true);
    const apply = ae.calls.find((c) => c.fn === "patchfitGrainApply")!.args;
    expect(apply).toMatchObject({ method: "add", degrain: "none", layer: { id: 100 }, replace_existing: false });
    expect(apply.intensity).toBeCloseTo(out.start_intensity, 4);
    expect(out.converged).toBe(true);
    expect(out.rounds.length).toBeGreaterThanOrEqual(2);
    // The first guess was too strong (the fake grain is 1.5x the placeholder curve): a tune write brought it down.
    const tunes = ae.calls.filter((c) => c.fn === "patchfitGrainTune");
    expect(tunes.length).toBeGreaterThanOrEqual(1);
    expect(tunes[0].args.intensity).toBeLessThan(apply.intensity);
    expect(out.final_intensity).toBeCloseTo(tunes[tunes.length - 1].args.intensity, 6);
    expect(out.rounds[0].tune_receipt.matches).toBe(true);
    const lastRound = out.rounds[out.rounds.length - 1];
    expect(lastRound.error).toBeLessThanOrEqual(0.1);
    expect(out.preview_path).toMatch(/patchfit_grain/);
    expect(out.sigma_after.patch.spatial[0]).toBeGreaterThan(2.5);
    // Every write came through the guarded path: guard, then read, write, read.
    const fns = ae.fns();
    const iA = fns.indexOf("patchfitGrainApply");
    expect(fns.slice(iA - 2, iA + 2)).toEqual(["checkGuard", "patchfitGrainState", "patchfitGrainApply", "patchfitGrainState"]);
  }, 60000);

  it("adds no grain to a clean plate", async () => {
    const ae = fakeAe({ scene: { plate: (_k, x, y, c) => tex(x, y, c), patch: (_k, x, y, c) => tex(x, y, c) } });
    const out = (await tool("ae_patch_grain").handler(grainArgs(), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.grain_added).toBe(false);
    expect(out.notes.join(" ")).toMatch(/clean/);
    expect(ae.fns()).not.toContain("patchfitGrainApply");
  });

  it("passes degrain, match and the viewing-mode override to the host", async () => {
    const ae = fakeAe({ scene: grainScene() });
    const out = (await tool("ae_patch_grain").handler(grainArgs({ degrain: "median", method: "match", plate_layer: { index: 2 }, viewing_mode_index: 3, rounds: 0, intensity: 0.2, grain_size: 1.5 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    const apply = ae.calls.find((c) => c.fn === "patchfitGrainApply")!.args;
    expect(apply).toMatchObject({ method: "match", degrain: "median", plate_layer: { index: 2 }, viewing_mode_index: 3, intensity: 0.2, size: 1.5 });
    expect(out.start_intensity).toBe(0.2);
    expect(ae.fns()).not.toContain("patchfitGrainTune");
  });

  it("refuses a locked layer before any write and warns at 32 bpc", async () => {
    const locked = fakeAe({ scene: grainScene(), info: { layer: { locked: true } } });
    const l = (await tool("ae_patch_grain").handler(grainArgs(), locked.ctx)) as Out;
    expect(l.ok).toBe(false);
    expect(locked.fns()).not.toContain("planarIsolateBegin");
    const deep = fakeAe({ scene: grainScene(), info: { comp: { bits_per_channel: 32 } } });
    const d = (await tool("ae_patch_grain").handler(grainArgs({ dry_run: true }), deep.ctx)) as Out;
    expect(d.notes.join(" ")).toMatch(/32-bpc/);
  });

  it("checks the matte, the layer order and the viewing mode in the read-back", () => {
    const good = {
      patch_effects: [],
      adjustment: { id: 200, adjustment_layer: true, above_patch: true },
      matte: { alpha: true, layer_id: 100 },
      effect: { params: [{ index: 1, name: "Viewing Mode", value: 2 }, { index: 2, name: "Intensity", value: 0.25 }] },
    };
    const args = { method: "add" as const, degrain: "none" as const, intensity: 0.25 };
    expect(grainMismatches(args, 100, null, good, { grain: { viewing_mode_index: 2 } })).toEqual([]);
    const bad = { ...good, matte: { alpha: false, layer_id: null }, effect: { params: [{ index: 1, name: "Viewing Mode", value: 1 }, { index: 2, name: "Intensity", value: 0.5 }] } };
    const m = grainMismatches(args, 100, null, bad, { grain: { viewing_mode_index: 2 } });
    expect(m.map((x) => x.path)).toEqual(expect.arrayContaining(["matte", "effect.intensity", "effect.viewing_mode"]));
  });
});

// ---------- ae_patch_finish ----------

const finishScene = (): Scene => ({
  plate: (k, x, y, c) => tex(x - 2 * k, y, c) + 8 * Math.sin(0.4 * x + 0.5 * y + c),
  // Sharper than the plate (extra fine detail) and brighter: a visible edge.
  patch: (k, x, y, c) => tex(x - 2 * k, y, c) + 8 * Math.sin(0.4 * x + 0.5 * y + c) + 25 * Math.sin(1.7 * x + 1.3 * y) + 35,
});
const finishArgs = (extra: Record<string, unknown> = {}) => AePatchFinishSchema.parse({ comp_id: 1, layer: { id: 100 }, region: REGION, expect: expectArg, ...extra });
const movingTrack = (id: string, dx: number) => {
  const frames = Array.from({ length: 10 }, (_, k) => ({ time: k / FPS, ok: true, H: translate(dx * k, 0), points: [], confidence: [], rms_px: 0, inliers: 1 }));
  saveTrack({ version: 1, track_id: id, comp_id: 1, comp_size: [W, H], fps: FPS, ref_time: 0, model: "translate", ref_points: [[0, 0]], frames, source: "test", created: "" } as PlanarTrack);
  return { track_id: id };
};
const MASK = { index: 1, name: "Mask 1", mode: 6813, feather: [0, 0], expansion: 0, feather_keyed: false, expansion_keyed: false };

describe("ae_patch_finish", () => {
  it("plans blur, feather, motion blur and layer quality from the measurements (dry_run writes nothing)", async () => {
    const ae = fakeAe({ scene: finishScene(), info: { layer: { masks: [MASK] } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, track: movingTrack("trk_pf_fin", 2) }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.measured.sharpness.patch_detail).toBeGreaterThan(out.measured.sharpness.ring_detail[0].energy);
    expect(out.plan.blur.values[0]).toBeGreaterThan(0);
    expect(out.plan.blur.replace_existing).toBe(false);
    expect(out.measured.edge.worst).toBeGreaterThan(1.5);
    expect(out.plan.edge.masks).toHaveLength(1);
    expect(out.plan.edge.masks[0].index).toBe(1);
    expect(out.plan.edge.masks[0].feather).toBeGreaterThan(1);
    expect(out.plan.edge.masks[0].expansion).toBeGreaterThanOrEqual(out.plan.edge.masks[0].feather / 2);
    expect(out.measured.motion_blur.p95_px).toBeCloseTo(1, 1);
    expect(out.measured.motion_blur.mover).toBe("layer transform");
    expect(out.plan.layer_switches).toMatchObject({ motion_blur: true, sampling_bicubic: true, frame_blend_none: true, quality_best: true });
    // The comp's motion blur affects every layer: only reported without allow_comp_change.
    expect(out.plan.comp).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/allow_comp_change/);
    expect(ae.fns()).not.toContain("patchfitFinishApply");
    expect(out.temp_comp.copy_removed).toBe(true);
  });

  it("writes the plan in one guarded step with the comp change when allowed, and reads it back", async () => {
    const ae = fakeAe({ scene: finishScene(), info: { layer: { masks: [MASK] } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ track: movingTrack("trk_pf_fin2", 2), allow_comp_change: true }), ae.ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.write.receipt.matches).toBe(true);
    expect(out.write.receipt.mismatches).toEqual([]);
    const apply = ae.calls.find((c) => c.fn === "patchfitFinishApply")!.args;
    expect(apply.comp).toEqual({ motion_blur: true });
    expect(apply.blur.times.length).toBe(apply.blur.values.length);
    expect(apply.expect).toMatchObject({ project_path: "<unsaved>" });
    const fns = ae.fns();
    const iA = fns.indexOf("patchfitFinishApply");
    expect(fns.slice(iA - 2, iA + 2)).toEqual(["checkGuard", "patchfitFinishState", "patchfitFinishApply", "patchfitFinishState"]);
    expect(out.crops_path).toMatch(/patchfit_finish/);
  });

  it("adds CC Force Motion Blur for a pinned patch and leaves layer motion blur alone", async () => {
    const ae = fakeAe({ scene: finishScene(), info: { layer: { pinned: true } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, track: movingTrack("trk_pf_fin3", 4), sharpness: false, edge: false }), ae.ctx)) as Out;
    expect(out.measured.motion_blur.mover).toBe("pin effect");
    expect(out.plan.force_motion_blur).toMatchObject({ shutter_angle: 180 });
    expect(out.plan.layer_switches?.motion_blur).toBeUndefined();
  });

  it("does not match motion blur without a track, or for a slow shot, and reports a layer with no masks", async () => {
    const ae = fakeAe({ scene: finishScene() });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true }), ae.ctx)) as Out;
    expect(out.measured.motion_blur.result).toMatch(/No track/);
    expect(out.plan.edge).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/no masks/);
    const slow = fakeAe({ scene: finishScene() });
    const s = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, track: movingTrack("trk_pf_slow", 0.2) }), slow.ctx)) as Out;
    expect(s.measured.motion_blur.result).toMatch(/under half a pixel/);
  });

  it("changes nothing when the patch already sits in the shot", async () => {
    const plain: Scene = { plate: (_k, x, y, c) => tex(x, y, c), patch: (_k, x, y, c) => tex(x, y, c) };
    const ae = fakeAe({ scene: plain, info: { layer: { sampling_bicubic: true, frame_blend_none: true, quality_best: true } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ motion_blur: false }), ae.ctx)) as Out;
    expect(out.applied).toBe(false);
    expect(out.notes.join(" ")).toMatch(/Nothing needs changing/);
    expect(ae.fns()).not.toContain("patchfitFinishApply");
  });

  it("refuses an existing sit-in blur without replace_existing", async () => {
    const ae = fakeAe({ scene: finishScene(), info: { layer: { effects: [{ index: 1, name: "Chroma sit-in blur", matchName: "ADBE Gaussian Blur 2" }] } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs(), ae.ctx)) as Out;
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/replace_existing/);
    expect(ae.fns()).not.toContain("planarIsolateBegin");
  });

  it("flags a read-back that does not show the plan", () => {
    const plan: FinishPlan = { blur: { times: [0, 1], values: [2, 4], replace_existing: false }, edge: { masks: [{ index: 1, feather: 5, expansion: 3 }] }, layer_switches: { motion_blur: true }, comp: { motion_blur: true } };
    const after = {
      comp: { motion_blur: false, shutter_angle: 180 },
      layer: { motion_blur: false, masks: [{ index: 1, feather: [0, 0] }] },
      blur: { index: 1, params: [{ index: 1, name: "Blurriness", num_keys: 0, samples: [{ time: 1, value: 1 }] }] },
      force_motion_blur: null,
    };
    const m = finishMismatches(plan, null, after, { edge: { masks: [{ index: 1, feather: 5, expansion: 3 }] } });
    expect(m.map((x) => x.path)).toEqual(expect.arrayContaining(["blur.num_keys", "blur@1", "masks[1].feather", "layer.motion_blur", "comp.motion_blur"]));
  });
});

// ---------- patchfit.jsx under node:vm ----------

function makeEffect(matchName: string): FakeGroup {
  const P = (name: string, v: number, mn = name, type: number = PropertyValueType.OneD) => new FakeProperty(name, mn, type, v);
  if (matchName === "ADBE Pro Levels2") {
    const props: FakeProperty[] = [P("Channel", 1)];
    for (const ch of ["Red", "Green", "Blue"]) {
      props.push(P(`${ch} Input Black`, 0), P(`${ch} Input White`, 1), P(`${ch} Gamma`, 1), P(`${ch} Output Black`, 0), P(`${ch} Output White`, 1));
    }
    // Output White cannot go above 1 here, like a bounded parameter.
    Object.assign(props.find((p) => p.name === "Red Output White") as FakeProperty, { hasMax: true, maxValue: 1 });
    return new FakeGroup("Levels (Individual Controls)", matchName, props);
  }
  if (matchName === "ADBE Exposure2") {
    const props: FakeProperty[] = [P("Channels", 1), P("Master Exposure", 0)];
    for (const ch of ["Red", "Green", "Blue"]) props.push(P(`${ch} Exposure`, 0), P(`${ch} Offset`, 0), P(`${ch} Gamma Correction`, 1));
    props.push(P("Bypass Linear Light Conversion", 0));
    return new FakeGroup("Exposure", matchName, props);
  }
  if (matchName === "ADBE Median") return new FakeGroup("Median", matchName, [P("Radius", 0)]);
  if (matchName === "VISINF Grain Removal") return new FakeGroup("Remove Grain", matchName, [P("Viewing Mode", 1)]);
  if (matchName === "VISINF Grain Implant") {
    return new FakeGroup("Add Grain", matchName, [P("Viewing Mode", 1), P("Intensity", 1), P("Size", 1), P("Softness", 1), P("Animation Speed", 0), P("Random Seed", 0)]);
  }
  if (matchName === "VISINF Grain Duplication") {
    return new FakeGroup("Match Grain", matchName, [P("Viewing Mode", 1), P("Noise Source Layer", 0, "Noise Source Layer", PropertyValueType.LAYER_INDEX), P("Intensity", 1)]);
  }
  if (matchName === "ADBE Gaussian Blur 2") return new FakeGroup("Gaussian Blur", matchName, [P("Blurriness", 0), P("Blur Dimensions", 1), P("Repeat Edge Pixels", 0)]);
  if (matchName === "CC Force Motion Blur") return new FakeGroup("CC Force Motion Blur", matchName, [P("Motion Blur Samples", 8), P("Override Shutter Angle", 0), P("Shutter Angle", 0)]);
  if (matchName === "ADBE Corner Pin") return new FakeGroup("Corner Pin", matchName, [P("Upper Left", 0)]);
  return new FakeGroup(matchName, matchName, []);
}

/** Lets a fake layer's Effects group add effects with an index and moveTo like AE's. */
function withEffects(layer: FakeLayer, existing: string[] = []): FakeGroup {
  const fx = layer.property("ADBE Effect Parade") as any;
  const add = (mn: string) => {
    const g = makeEffect(mn) as any;
    g.parentProperty = fx;
    fx.props.push(g);
    Object.defineProperty(g, "propertyIndex", { get: () => fx.props.indexOf(g) + 1 });
    g.moveTo = (i: number) => {
      fx.props.splice(fx.props.indexOf(g), 1);
      fx.props.splice(i - 1, 0, g);
    };
    return g;
  };
  fx.addProperty = add;
  for (const mn of existing) add(mn);
  return fx;
}

function scene(files: string[] = ["patchfit.jsx"]) {
  const project = new FakeProject();
  (project as any).bitsPerChannel = 8;
  const comp = project.addComp("Main", 640, 360, 4) as FakeComp;
  (comp as any).motionBlur = false;
  (comp as any).shutterAngle = 180;
  const plate = comp.layers.addSolid([0, 0, 0], "Plate", 640, 360, 1) as FakeLayer;
  const patch = comp.layers.addSolid([1, 1, 1], "Patch", 200, 200, 1) as FakeLayer;
  const fx = withEffects(patch);
  // Every layer made later (the grain layer) can take effects too.
  const addSolid = comp.layers.addSolid;
  comp.layers.addSolid = (...a: any[]) => {
    const l = addSolid(...a) as FakeLayer;
    withEffects(l);
    return l;
  };
  for (const l of [plate, patch]) Object.assign(l, { samplingQuality: 1, frameBlendingType: 1, quality: 1 });
  const host = loadHost(project, files);
  Object.assign(host.G, { LayerQuality: { BEST: 3 }, LayerSamplingQuality: { BICUBIC: 4 }, FrameBlendingType: { NO_FRAME_BLEND: 2 } });
  return { project, comp, plate, patch, fx, ...host };
}

const series = (mode: "levels" | "exposure", times: number[]) => {
  const one = (k: number) => (mode === "levels" ? { in_black: times.map(() => 0), in_white: times.map(() => 1), out_black: times.map((_, i) => 0.02 * i + k), out_white: times.map((_, i) => 0.9 - 0.02 * i) } : { exposure: times.map((_, i) => 0.1 * i + k), offset: times.map((_, i) => 0.01 * i) });
  return { red: one(0), green: one(0.01), blue: one(0.02) };
};

describe("patchfit.jsx: patchfitInfo", () => {
  it("lists the plate layers, the patch's effects, masks and switches, and changes nothing", () => {
    const s = scene();
    const off = s.comp.layers.addSolid([0, 0, 0], "Hidden", 10, 10, 1) as FakeLayer;
    off.enabled = false;
    (s.patch as any).motionBlur = true;
    const mask = (s.patch.property("ADBE Mask Parade") as any).addProperty("ADBE Mask Atom");
    mask.property("ADBE Mask Feather").setValue([4, 4]);
    s.fx.addProperty("ADBE Corner Pin");
    const out = s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id } });
    expect(out.comp).toMatchObject({ width: 640, height: 360, shutter_angle: 180, motion_blur: false, bits_per_channel: 8 });
    expect(out.layer).toMatchObject({ name: "Patch", motion_blur: true, pinned: true, sampling_bicubic: false });
    expect(out.layer.masks[0]).toMatchObject({ index: 1, feather: [4, 4] });
    expect(out.layer.effects.map((e: any) => e.matchName)).toEqual(["ADBE Corner Pin"]);
    // The patch and the switched-off layer are not part of the plate; the other layer is.
    expect(out.show.map((l: any) => l.id)).toEqual([s.plate.id]);
    expect(s.undo.begun).toBe(0);
  });

  it("gives the comp scale through the layer's Scale and its parents' and flags keyed Scale", () => {
    const s = scene();
    expect(s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id } }).layer.comp_scale).toMatchObject({ x: 1, y: 1, keyed: false });
    (s.patch.property("ADBE Transform Group") as any).property("ADBE Scale").setValue([50, 50, 100]);
    (s.plate.property("ADBE Transform Group") as any).property("ADBE Scale").setValue([80, 80, 100]);
    (s.patch as any).parent = s.plate;
    const out = s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id } }).layer;
    expect(out.comp_scale.x).toBeCloseTo(0.4, 6);
    expect(out.comp_scale.y).toBeCloseTo(0.4, 6);
    expect(out.comp_scale.keyed).toBe(false);
    (s.plate.property("ADBE Transform Group") as any).property("ADBE Scale").setValueAtTime(0, [80, 80, 100]);
    (s.plate.property("ADBE Transform Group") as any).property("ADBE Scale").setValueAtTime(1, [90, 90, 100]);
    expect(s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id } }).layer.comp_scale.keyed).toBe(true);
  });

  it("switches more layers off with hide_layers", () => {
    const s = scene();
    const out = s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id }, hide_layers: [{ id: s.plate.id }] });
    expect(out.show).toEqual([]);
    expect(out.hidden.map((l: any) => l.name)).toEqual(["Plate"]);
  });
});

describe("patchfit.jsx: patchfitColorApply", () => {
  const times = [0, 0.5, 1];

  it("adds Levels, resolves the parameters by name, keys them and returns the table", () => {
    const s = scene();
    const out = s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: series("levels", times), expect: GUARD });
    expect(out.effect).toMatchObject({ name: COLOR_EFFECT_NAME, matchName: "ADBE Pro Levels2" });
    expect(out.scale).toBe(1);
    expect(out.table.filter((r: any) => r.how === "name")).toHaveLength(12);
    expect(s.undo.begun).toBe(1);
    expect(s.undo.ended).toBe(1);
    const fx = s.fx.property(1) as any;
    expect(fx.name).toBe(COLOR_EFFECT_NAME);
    const ob = fx.property("Green Output Black");
    expect(ob.numKeys).toBe(3);
    expect(ob.keyValue(2)).toBeCloseTo(0.03);
    expect(ob.keyInterpolationType === undefined || ob.keyInInterpolationType(1)).toBeTruthy();
    // The red Output White is bounded at 1; the series stays under it so nothing is clamped.
    expect(out.clamped).toEqual([]);
  });

  it("clamps to a parameter's own limit and says so", () => {
    const s = scene();
    const sr = series("levels", times);
    sr.red.out_white = [1.2, 1.1, 1];
    const out = s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: sr, expect: GUARD });
    expect(out.clamped.join(" ")).toMatch(/red.out_white 1.2 -> 1/);
    expect((s.fx.property(1) as any).property("Red Output White").keyValue(1)).toBe(1);
  });

  it("scales Levels values to the unit the effect reports", () => {
    const s = scene();
    const fx = s.fx as any;
    const original = fx.addProperty;
    fx.addProperty = (mn: string) => {
      const g = original(mn);
      for (const ch of ["Red", "Green", "Blue"]) g.property(`${ch} Input White`).staticValue = 255;
      return g;
    };
    const out = s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times: [0], series: series("levels", [0]), expect: GUARD });
    expect(out.scale).toBe(255);
    const g = s.fx.property(1) as any;
    expect(g.property("Blue Input White").staticValue).toBeCloseTo(255);
    expect(g.property("Red Output Black").staticValue).toBeCloseTo(0);
  });

  it("keys Exposure per channel with the channels split and the linear conversion bypassed", () => {
    const s = scene();
    const out = s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "exposure", times, series: series("exposure", times), expect: GUARD });
    expect(out.effect.matchName).toBe("ADBE Exposure2");
    const fx = s.fx.property(1) as any;
    expect(fx.property("Channels").staticValue).toBe(2);
    expect(fx.property("Bypass Linear Light Conversion").staticValue).toBe(1);
    expect(fx.property("Blue Exposure").numKeys).toBe(3);
    const off = scene();
    const o = off.A.patchfitColorApply({ comp_id: off.comp.id, layer: { id: off.patch.id }, mode: "exposure", times, series: series("exposure", times), bypass_linear: false, expect: GUARD });
    expect(o.notes).toEqual([]);
    expect((off.fx.property(1) as any).property("Bypass Linear Light Conversion").staticValue).toBe(0);
  });

  it("writes one value when there is one time", () => {
    const s = scene();
    s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "exposure", times: [0], series: series("exposure", [0]), expect: GUARD });
    expect((s.fx.property(1) as any).property("Red Exposure").numKeys).toBe(0);
  });

  it("refuses a locked layer, bad series and a guard mismatch before the undo group opens", () => {
    const s = scene();
    const call = (over: Record<string, unknown>) => () => s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: series("levels", times), expect: GUARD, ...over });
    s.patch.locked = true;
    expect(call({})).toThrow(/locked/);
    s.patch.locked = false;
    expect(call({ times: [0, 0.5, 0.4] })).toThrow(/ascend/);
    expect(call({ times: [] })).toThrow(/non-empty/);
    expect(call({ series: { red: {}, green: {}, blue: {} } })).toThrow(/needs 3 values/);
    const bad = series("levels", times);
    bad.red.in_black[1] = NaN;
    expect(call({ series: bad })).toThrow(/finite/);
    expect(call({ mode: "curves" })).toThrow(/levels or exposure/);
    expect(call({ expect: { project_path: "/elsewhere.aep" } })).toThrow(/guard/);
    expect(call({ expect: undefined })).toThrow(/no expect.project_path/);
    expect(s.undo.begun).toBe(0);
    expect(s.fx.numProperties).toBe(0);
  });

  it("refuses to reuse its effect without replace_existing, replaces it with it, and never touches foreign effects", () => {
    const s = scene();
    withEffects(s.patch, ["ADBE Corner Pin"]);
    const run = (extra: Record<string, unknown> = {}) => s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: series("levels", times), expect: GUARD, ...extra });
    run();
    expect(() => run()).toThrow(/replace_existing/);
    const out = run({ replace_existing: true });
    expect(out.replaced).toBe(true);
    const names = s.fx.props.map((p: any) => p.name);
    expect(names.filter((n: string) => n === COLOR_EFFECT_NAME)).toHaveLength(1);
    expect(names).toContain("Corner Pin");
  });

  it("removes the effect again and says what the effect has when a parameter name is not found", () => {
    const s = scene();
    const fx = s.fx as any;
    const original = fx.addProperty;
    fx.addProperty = (mn: string) => {
      const g = original(mn);
      g.property("Green Output Black").name = "Grün Ausgabe Schwarz";
      g.property("Grün Ausgabe Schwarz").matchName = "x";
      return g;
    };
    expect(() => s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: series("levels", times), expect: GUARD })).toThrow(/Green Output Black.*It has: .*Grün Ausgabe Schwarz/);
    expect(s.fx.numProperties).toBe(0);
    // The group still closed.
    expect(s.undo.begun).toBe(1);
    expect(s.undo.ended).toBe(1);
  });

  it("puts the effect before a pin through the shared effect order (planar.jsx)", () => {
    const s = scene(["planar.jsx", "patchfit.jsx"]);
    withEffects(s.patch, ["ADBE Corner Pin"]);
    const out = s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: series("levels", times), expect: GUARD });
    expect(out.slot).toEqual({ wanted: 1, moved: true });
    expect(s.fx.props.map((p: any) => p.matchName)).toEqual(["ADBE Pro Levels2", "ADBE Corner Pin"]);
    expect(s.A.patchfitEffectState({ comp_id: s.comp.id, layer: { id: s.patch.id }, name: COLOR_EFFECT_NAME, times: [0.5] }).effect.index).toBe(1);
  });
});

describe("patchfit.jsx: patchfitEffectState", () => {
  it("reads parameters and sampled values, and changes nothing", () => {
    const s = scene();
    s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "exposure", times: [0, 1], series: series("exposure", [0, 1]), expect: GUARD });
    const begun = s.undo.begun;
    const st = s.A.patchfitEffectState({ comp_id: s.comp.id, layer: { id: s.patch.id }, name: COLOR_EFFECT_NAME, times: [0, 0.5, 1] });
    const red = st.effect.params.find((p: any) => p.name === "Red Exposure");
    expect(red.num_keys).toBe(2);
    expect(red.samples.map((x: any) => x.time)).toEqual([0, 0.5, 1]);
    expect(red.samples[1].value).toBeCloseTo(0.05);
    expect(st.effects).toHaveLength(1);
    expect(s.A.patchfitEffectState({ comp_id: s.comp.id, layer: { id: s.patch.id }, name: "Nope" }).effect).toBeNull();
    expect(s.undo.begun).toBe(begun);
  });
});

describe("patchfit.jsx: patchfitGrainApply", () => {
  const apply = (s: ReturnType<typeof scene>, extra: Record<string, unknown> = {}) =>
    s.A.patchfitGrainApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, method: "add", degrain: "none", intensity: 0.4, size: 1.5, expect: GUARD, ...extra });

  it("makes the adjustment layer above the patch, matted to its alpha, with Add Grain at Final Output", () => {
    const s = scene();
    const out = apply(s);
    expect(s.undo.begun).toBe(1);
    expect(s.undo.ended).toBe(1);
    const adj = s.comp.layer("Patch GRAIN") as FakeLayer;
    expect(adj.adjustmentLayer).toBe(true);
    expect(adj.index).toBe(s.patch.index - 1);
    expect(adj.trackMatteLayer).toBe(s.patch);
    expect(adj.trackMatteType).toBe(5013);
    expect(s.patch.enabled).toBe(true);
    const g = (adj.property("ADBE Effect Parade") as any).property(1);
    expect(g.name).toBe("Chroma grain");
    expect(g.property("Viewing Mode").staticValue).toBe(3);
    expect(g.property("Intensity").staticValue).toBeCloseTo(0.4);
    expect(g.property("Size").staticValue).toBe(1.5);
    expect(g.property("Animation Speed").staticValue).toBe(1);
    expect(g.property("Random Seed").staticValue).toBeGreaterThan(0);
    expect(out.grain.table.find((r: any) => r.role === "viewing_mode").how).toBe("name");
    expect(out.grain.viewing_mode_index).toBe(3);
    expect(out.adjustment.name).toBe("Patch GRAIN");
  });

  it("degrains the patch first (Median radius 1, or Remove Grain at Final Output)", () => {
    const s = scene();
    apply(s, { degrain: "median" });
    const med = s.fx.property(1) as any;
    expect(med.name).toBe("Chroma degrain");
    expect(med.property("Radius").staticValue).toBe(1);
    const r = scene();
    const rg = apply(r, { degrain: "remove_grain" });
    // Final Output is the last item: Remove Grain 4 (Add Grain 3, Match Grain 5); the grain override does not move it.
    expect((r.fx.property(1) as any).property("Viewing Mode").staticValue).toBe(4);
    expect(rg.degrain.viewing_mode_index).toBe(4);
    const r2 = scene();
    apply(r2, { degrain: "remove_grain", degrain_viewing_mode_index: 6, viewing_mode_index: 2 });
    expect((r2.fx.property(1) as any).property("Viewing Mode").staticValue).toBe(6);
    expect(((r2.comp.layer("Patch GRAIN") as FakeLayer).property("ADBE Effect Parade") as any).property(1).property("Viewing Mode").staticValue).toBe(2);
  });

  it("uses Match Grain with the plate as its noise source", () => {
    const s = scene();
    const out = apply(s, { method: "match", plate_layer: { id: s.plate.id } });
    const adj = s.comp.layer("Patch GRAIN") as FakeLayer;
    const mg = (adj.property("ADBE Effect Parade") as any).property(1);
    expect(mg.matchName).toBe("VISINF Grain Duplication");
    expect(mg.property("Noise Source Layer").staticValue).toBe(s.plate.index);
    expect(out.notes.join(" ")).toMatch(/plate's effects feed it/);
    expect(() => apply(scene(), { method: "match" })).toThrow(/plate_layer/);
  });

  it("chooses the input stage on an AE that has it", () => {
    const s = scene();
    const calls: unknown[][] = [];
    const fx = s.comp.layer("Patch") as FakeLayer;
    void fx;
    // The adjustment layer's effect is made on demand: give every new Match Grain the stage call.
    const original = (s.comp.layers as any).addSolid;
    (s.comp.layers as any).addSolid = (...a: any[]) => {
      const l = original(...a);
      const parade = withEffects(l);
      const add = (parade as any).addProperty;
      (parade as any).addProperty = (mn: string) => {
        const g = add(mn);
        const np = g.property("Noise Source Layer");
        if (np) np.setInputLayerAndStage = (...x: unknown[]) => calls.push(x);
        return g;
      };
      return l;
    };
    (s.G as any).LayerInputStageType = { SOURCE: 1 };
    const out = apply(s, { method: "match", plate_layer: { id: s.plate.id } });
    expect(calls).toEqual([[s.plate.index, 1]]);
    expect(out.notes.join(" ")).not.toMatch(/plate's effects feed it/);
  });

  it("refuses before the undo group: locked layer, no matte API, a layer with that name, bad intensity", () => {
    const s = scene();
    s.patch.locked = true;
    expect(() => apply(s)).toThrow(/locked/);
    s.patch.locked = false;
    expect(() => apply(s, { intensity: -1 })).toThrow(/intensity/);
    expect(() => apply(s, { degrain: "denoise" })).toThrow(/degrain/);
    expect(() => apply(s, { method: "other" })).toThrow(/method/);
    const noMatte = scene();
    (noMatte.patch as any).setTrackMatte = undefined;
    expect(() => apply(noMatte)).toThrow(/AE 23/);
    const clash = scene();
    clash.comp.layers.addSolid([0, 0, 0], "Patch GRAIN", 10, 10, 1);
    expect(() => apply(clash)).toThrow(/not made by this tool/);
    expect(s.undo.begun).toBe(0);
    expect(clash.undo.begun).toBe(0);
  });

  it("refuses to repeat, and replaces its own layer and degrain with replace_existing", () => {
    const s = scene();
    apply(s, { degrain: "median" });
    expect(() => apply(s)).toThrow(/replace_existing/);
    apply(s, { degrain: "median", replace_existing: true });
    expect(s.comp.layers.length === undefined ? s.comp.numLayers : s.comp.numLayers).toBe(3);
    expect(s.fx.props.filter((p: any) => p.name === "Chroma degrain")).toHaveLength(1);
  });

  const solidItems = (s: ReturnType<typeof scene>) => s.project.all.filter((x: any) => x.mainSource && x.mainSource.constructor && x.mainSource.constructor.name === "SolidSource").length;

  it("removes the solid item of a replaced grain layer, but keeps one another layer still uses", () => {
    const s = scene();
    const before = solidItems(s);
    apply(s, { degrain: "median" });
    expect(solidItems(s)).toBe(before + 1);
    apply(s, { degrain: "median", replace_existing: true });
    expect(solidItems(s)).toBe(before + 1);
    // A second layer on the same grain solid keeps the item when the grain layer is replaced.
    const grain = (s.comp as any).stack.find((l: any) => l.name === "Patch GRAIN");
    expect(grain).toBeTruthy();
    const extra = s.comp.layers.add(grain.source);
    expect(extra).toBeTruthy();
    (extra as any).name = "Other";
    apply(s, { degrain: "median", replace_existing: true });
    expect(solidItems(s)).toBe(before + 2);
  });

  it("removes the grain layer again when the grain effect lacks a parameter", () => {
    const s = scene();
    const before = solidItems(s);
    const original = (s.comp.layers as any).addSolid;
    (s.comp.layers as any).addSolid = (...a: any[]) => {
      const l = original(...a);
      const parade = withEffects(l);
      const add = (parade as any).addProperty;
      (parade as any).addProperty = (mn: string) => {
        const g = add(mn);
        g.property("Intensity").name = "Stärke";
        return g;
      };
      return l;
    };
    expect(() => apply(s)).toThrow(/Add Grain is missing a parameter.*Stärke/);
    expect(s.comp.numLayers).toBe(2);
    expect(solidItems(s)).toBe(before);
  });
});

describe("patchfit.jsx: patchfitGrainTune and patchfitGrainState", () => {
  it("tunes the intensity in its own undo step and reads the layer, matte and effect back", () => {
    const s = scene();
    s.A.patchfitGrainApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, method: "add", degrain: "none", intensity: 0.4, expect: GUARD });
    const adj = s.comp.layer("Patch GRAIN") as FakeLayer;
    const begun = s.undo.begun;
    const out = s.A.patchfitGrainTune({ comp_id: s.comp.id, layer: { id: adj.id }, intensity: 0.25, expect: GUARD });
    expect(out).toMatchObject({ intensity_before: 0.4, intensity: 0.25 });
    expect(s.undo.begun).toBe(begun + 1);
    const st = s.A.patchfitGrainState({ comp_id: s.comp.id, patch: { id: s.patch.id } });
    expect(st.adjustment).toMatchObject({ adjustment_layer: true, above_patch: true });
    expect(st.matte).toEqual({ type: 5013, layer_id: s.patch.id, alpha: true });
    const intensity = st.effect.params.find((p: any) => p.name === "Intensity");
    expect(intensity.value).toBeCloseTo(0.25);
    expect(s.undo.begun).toBe(begun + 1);
  });

  it("refuses a keyframed intensity, a layer without the effect and a locked layer", () => {
    const s = scene();
    s.A.patchfitGrainApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, method: "add", degrain: "none", intensity: 0.4, expect: GUARD });
    const adj = s.comp.layer("Patch GRAIN") as FakeLayer;
    const tune = (id: number, v = 0.2) => () => s.A.patchfitGrainTune({ comp_id: s.comp.id, layer: { id }, intensity: v, expect: GUARD });
    expect(tune(s.plate.id)).toThrow(/not made by ae_patch_grain/);
    expect(tune(adj.id, -1)).toThrow(/intensity/);
    adj.locked = true;
    expect(tune(adj.id)).toThrow(/locked/);
    adj.locked = false;
    ((adj.property("ADBE Effect Parade") as any).property(1).property("Intensity") as FakeProperty).setValueAtTime(0, 1);
    expect(tune(adj.id)).toThrow(/keyframed/);
  });
});

describe("patchfit.jsx: patchfitFinishApply", () => {
  const apply = (s: ReturnType<typeof scene>, extra: Record<string, unknown>) => s.A.patchfitFinishApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, expect: GUARD, ...extra });

  it("adds a keyed Gaussian Blur with Repeat Edge Pixels on", () => {
    const s = scene();
    const out = apply(s, { blur: { times: [0, 1], values: [2, 4] } });
    const fx = s.fx.property(1) as any;
    expect(fx.name).toBe("Chroma sit-in blur");
    expect(fx.property("Blurriness").numKeys).toBe(2);
    expect(fx.property("Blurriness").keyValue(2)).toBe(4);
    expect(fx.property("Repeat Edge Pixels").staticValue).toBe(1);
    expect(out.blur.table[0]).toMatchObject({ role: "blurriness", how: "name" });
    expect(s.undo.begun).toBe(1);
  });

  it("feathers the masks, keeps the expansion, and skips keyframed ones", () => {
    const s = scene();
    const masks = s.patch.property("ADBE Mask Parade") as any;
    masks.addProperty("ADBE Mask Atom");
    masks.addProperty("ADBE Mask Atom");
    masks.property(2).property("ADBE Mask Feather").setValueAtTime(0, [1, 1]);
    const out = apply(s, { edge: { feather: 6, expansion: 3 } });
    expect(out.edge.masks).toEqual([{ index: 1, feather: 6, expansion: 3 }]);
    expect(out.edge.skipped[0]).toMatchObject({ index: 2 });
    expect(masks.property(1).property("ADBE Mask Feather").staticValue).toEqual([6, 6]);
    expect(masks.property(1).property("ADBE Mask Offset").staticValue).toBe(3);
  });

  it("sets the layer and comp motion blur and quality, adds CC Force Motion Blur after the pin", () => {
    const s = scene(["planar.jsx", "patchfit.jsx"]);
    withEffects(s.patch, ["ADBE Corner Pin"]);
    const out = apply(s, {
      layer_switches: { motion_blur: true, sampling_bicubic: true, frame_blend_none: true, quality_best: true },
      comp: { motion_blur: true, shutter_angle: 270 },
      force_motion_blur: { shutter_angle: 270 },
    });
    expect((s.patch as any).motionBlur).toBe(true);
    expect((s.patch as any).samplingQuality).toBe(4);
    expect((s.patch as any).frameBlendingType).toBe(2);
    expect((s.patch as any).quality).toBe(3);
    expect((s.comp as any).motionBlur).toBe(true);
    expect((s.comp as any).shutterAngle).toBe(270);
    expect(s.fx.props.map((p: any) => p.matchName)).toEqual(["ADBE Corner Pin", "CC Force Motion Blur"]);
    const f = s.fx.property(2) as any;
    expect(f.property("Override Shutter Angle").staticValue).toBe(1);
    expect(f.property("Shutter Angle").staticValue).toBe(270);
    expect(out.force_motion_blur.slot).toEqual({ wanted: 2, moved: false });
    const st = s.A.patchfitFinishState({ comp_id: s.comp.id, layer: { id: s.patch.id } });
    expect(st.layer).toMatchObject({ motion_blur: true, sampling_bicubic: true, frame_blend_none: true, quality_best: true });
    expect(st.comp).toMatchObject({ motion_blur: true, shutter_angle: 270 });
    expect(st.force_motion_blur).not.toBeNull();
  });

  it("refuses before the group: locked, a layer with no masks, bad blur keys, a shutter angle out of range, an existing blur", () => {
    const s = scene();
    s.patch.locked = true;
    expect(() => apply(s, { layer_switches: { quality_best: true } })).toThrow(/locked/);
    s.patch.locked = false;
    expect(() => apply(s, { edge: { feather: 4, expansion: 2 } })).toThrow(/no masks/);
    expect(() => apply(s, { blur: { times: [0, 1], values: [1] } })).toThrow(/matching/);
    expect(() => apply(s, { blur: { times: [1, 0], values: [1, 2] } })).toThrow(/ascending/);
    expect(() => apply(s, { blur: { times: [0], values: [-1] } })).toThrow(/Blurriness/);
    expect(() => apply(s, { comp: { shutter_angle: 900 } })).toThrow(/0..720/);
    expect(() => apply(s, { force_motion_blur: { shutter_angle: -5 } })).toThrow(/0..720/);
    expect(s.undo.begun).toBe(0);
    apply(s, { blur: { times: [0], values: [2] } });
    expect(() => apply(s, { blur: { times: [0], values: [3] } })).toThrow(/replace_existing/);
    apply(s, { blur: { times: [0], values: [3], replace_existing: true } });
    expect(s.fx.props.filter((p: any) => p.name === "Chroma sit-in blur")).toHaveLength(1);
  });
});

// ---------- fixes found in review ----------

describe("review fixes: pure helpers", () => {
  it("carries a gain into linear light as 2.2 stops per encoded stop and drops the offset", () => {
    const e = exposureLinearFromGainOffset(2, 0.1);
    near(e.exposure, ENCODED_TO_LINEAR_EXPONENT, 1e-9);
    expect(e.offset).toBe(0);
    expect(exposureFromGainOffset(2, 0.1).exposure).toBeCloseTo(1, 9);
  });

  it("builds Exposure keys on the linear path (stops x 2.2, offset 0) and says the offset was dropped", () => {
    const curves = { gain: [[1, 2], [1, 2], [1, 2]], offset: [[0.05, 0.05], [0.05, 0.05], [0.05, 0.05]], filled: [], usable: 2 };
    const direct = buildKeys([0, 1], curves, "exposure");
    expect(direct.linear).toBe(false);
    expect(direct.series.red.exposure[1]).toBeCloseTo(1, 5);
    expect(direct.series.red.offset[0]).toBeCloseTo(0.05, 5);
    const lin = buildKeys([0, 1], curves, "exposure", { linear: true });
    expect(lin.linear).toBe(true);
    expect(lin.offsetDropped).toBe(true);
    expect(lin.series.red.exposure[1]).toBeCloseTo(2.2, 5);
    expect(lin.series.red.offset).toEqual([0, 0]);
    expect(buildKeys([0, 1], curves, "levels", { linear: true }).linear).toBe(false);
  });

  it("finds its own effects from the host's full scan, else from the (cut) list", () => {
    const base = hostInfo().layer as any;
    expect(ownEffectIndex(base, "blur", "Chroma sit-in blur")).toBeNull();
    expect(ownEffectIndex({ ...base, effects: [{ index: 3, name: "Chroma sit-in blur", matchName: "x" }] }, "blur", "Chroma sit-in blur")).toBe(3);
    const cut = { ...base, effects: [], effects_total: 600, effects_truncated: true, own_effects: { color: 580, blur: null, force_motion_blur: null, grain: null, degrain: null } };
    expect(ownEffectIndex(cut, "color", COLOR_EFFECT_NAME)).toBe(580);
    expect(ownEffectIndex(cut, "blur", "Chroma sit-in blur")).toBeNull();
  });

  it("counts effects by the true total, not the cut list", () => {
    const keys = { times: [0, 1], series: { red: { exposure: [0, 1], offset: [0, 0] }, green: { exposure: [0, 1], offset: [0, 0] }, blue: { exposure: [0, 1], offset: [0, 0] } }, clamped: false, constant: false, noDrift: false, linear: false, offsetDropped: false };
    const params: any[] = [];
    let i = 1;
    for (const label of ["Red", "Green", "Blue"]) {
      for (const [suffix, end] of [["Exposure", 1], ["Offset", 0]] as Array<[string, number]>) params.push({ index: i++, name: `${label} ${suffix}`, matchName: "", type: "1d", num_keys: 2, expression: false, value: 0, samples: [{ time: 1, value: end }] });
    }
    const list = Array.from({ length: 500 }, (_, k) => ({ index: k + 1, name: "x", matchName: "y" }));
    const before = { layer: {}, effects: list, effects_total: 520, effect: null };
    const good = { layer: {}, effects: list, effects_total: 521, effect: { index: 1, name: COLOR_EFFECT_NAME, matchName: "ADBE Exposure2", params } };
    expect(colorMismatches("exposure", keys, before, good, { scale: 1, slot: { wanted: 1 } })).toEqual([]);
    const bad = { ...good, effects_total: 520 };
    expect(colorMismatches("exposure", keys, before, bad, { scale: 1, slot: { wanted: 1 } }).map((m) => m.path)).toContain("effects");
  });

  it("checks Exposure's Channels and Bypass Linear Light Conversion in the read-back", () => {
    const keys = { times: [0], series: { red: { exposure: [0.5], offset: [0] }, green: { exposure: [0.5], offset: [0] }, blue: { exposure: [0.5], offset: [0] } }, clamped: false, constant: true, noDrift: false, linear: false, offsetDropped: false };
    const params = (channels: number, bypass: number) => {
      const out: any[] = [];
      let i = 1;
      for (const label of ["Red", "Green", "Blue"]) {
        for (const [suffix, v] of [["Exposure", 0.5], ["Offset", 0]] as Array<[string, number]>) out.push({ index: i++, name: `${label} ${suffix}`, matchName: "", type: "1d", num_keys: 0, expression: false, value: v, samples: [] });
      }
      out.push({ index: i++, name: "Channels", matchName: "", type: "1d", num_keys: 0, expression: false, value: channels, samples: [] });
      out.push({ index: i++, name: "Bypass Linear Light Conversion", matchName: "", type: "1d", num_keys: 0, expression: false, value: bypass, samples: [] });
      return out;
    };
    const st = (p: any[]) => ({ layer: {}, effects: [{ index: 1, name: "x", matchName: "y" }], effect: { index: 1, name: COLOR_EFFECT_NAME, matchName: "ADBE Exposure2", params: p } });
    const before = { layer: {}, effects: [], effect: null };
    const written = { scale: 1, slot: { wanted: 1 }, channels_written: 2, bypass_written: 1 };
    expect(colorMismatches("exposure", keys, before, st(params(2, 1)), written)).toEqual([]);
    expect(colorMismatches("exposure", keys, before, st(params(1, 1)), written).map((m) => m.path)).toEqual(["effect.channels"]);
    expect(colorMismatches("exposure", keys, before, st(params(2, 0)), written).map((m) => m.path)).toEqual(["effect.bypass"]);
    // Nothing is claimed about switches the host did not write.
    expect(colorMismatches("exposure", keys, before, st(params(1, 0)), { scale: 1, slot: { wanted: 1 } })).toEqual([]);
  });

  it("checks the patch is still on, the grain layer spans it, and Remove Grain's Viewing Mode", () => {
    const args = { method: "add" as const, degrain: "remove_grain" as const, intensity: 0.25 };
    const good = {
      patch: { enabled: true, in_point: 1, out_point: 3 },
      patch_effects: [{ name: "Chroma degrain" }],
      degrain: { params: [{ index: 1, name: "Viewing Mode", value: 4 }] },
      adjustment: { id: 200, adjustment_layer: true, above_patch: true, in_point: 1, out_point: 3 },
      matte: { alpha: true, layer_id: 100 },
      effect: { params: [{ index: 1, name: "Viewing Mode", value: 3 }, { index: 2, name: "Intensity", value: 0.25 }] },
    };
    const written = { grain: { viewing_mode_index: 3 }, degrain: { viewing_mode_index: 4 } };
    const before = { patch: { enabled: true }, patch_effects: [] };
    expect(grainMismatches(args, 100, before, good, written)).toEqual([]);
    const off = grainMismatches(args, 100, before, { ...good, patch: { ...good.patch, enabled: false } }, written);
    expect(off.map((m) => m.path)).toEqual(["patch.enabled"]);
    // A patch the user had switched off is left as it was.
    expect(grainMismatches(args, 100, { patch: { enabled: false }, patch_effects: [] }, { ...good, patch: { ...good.patch, enabled: false } }, written)).toEqual([]);
    const span = grainMismatches(args, 100, before, { ...good, adjustment: { ...good.adjustment, in_point: 0, out_point: 2 } }, written);
    expect(span.map((m) => m.path)).toEqual(["adjustment.span"]);
    const mode = grainMismatches(args, 100, before, { ...good, degrain: { params: [{ index: 1, name: "Viewing Mode", value: 2 }] } }, written);
    expect(mode.map((m) => m.path)).toEqual(["degrain.viewing_mode"]);
  });

  it("compares the comp's shutter angle within half a degree and checks each mask's expansion", () => {
    const plan: FinishPlan = { comp: { shutter_angle: 173 }, edge: { masks: [{ index: 1, feather: 5, expansion: 3 }] } };
    const after = { comp: { motion_blur: true, shutter_angle: 173 }, layer: { masks: [{ index: 1, feather: [5, 5], expansion: 3 }] } };
    expect(finishMismatches(plan, null, after, { edge: { masks: plan.edge!.masks } })).toEqual([]);
    const drift = { comp: { motion_blur: true, shutter_angle: 180 }, layer: { masks: [{ index: 1, feather: [5, 5], expansion: 0 }] } };
    expect(finishMismatches(plan, null, drift, { edge: { masks: plan.edge!.masks } }).map((m) => m.path)).toEqual(expect.arrayContaining(["masks[1].expansion", "comp.shutter_angle"]));
  });
});

describe("review fixes: the colour tool", () => {
  it("writes Exposure with the conversion on: stops x 2.2, offset 0, and says so", async () => {
    const ae = fakeAe({ scene: driftScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ effect: "exposure", bypass_linear: false, verify: false }), ae.ctx)) as Out;
    expect(out.write.receipt.matches).toBe(true);
    const apply = ae.calls.find((c) => c.fn === "patchfitColorApply")!.args;
    expect(apply.bypass_linear).toBe(false);
    expect(apply.series.red.offset.every((v: number) => v === 0)).toBe(true);
    const last = apply.series.red.exposure[apply.series.red.exposure.length - 1];
    near(last, 2.2 * Math.log2(GAIN(9)[0]), 0.05);
    expect(out.notes.join(" ")).toMatch(/2\.2 x log2/);
    const direct = fakeAe({ scene: driftScene() });
    const d = (await tool("ae_patch_color_match").handler(colorArgs({ effect: "exposure", verify: false }), direct.ctx)) as Out;
    expect(d.notes.join(" ")).toMatch(/Bypass Linear Light Conversion/);
  });

  it("flags Individual Channels or the bypass switch that did not take", async () => {
    const wrong = fakeAe({ scene: driftScene(), channelsValue: 1 });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ effect: "exposure", verify: false }), wrong.ctx)) as Out;
    expect(out.write.receipt.matches).toBe(false);
    expect(out.write.receipt.mismatches.map((m: any) => m.path)).toContain("effect.channels");
    const bypass = fakeAe({ scene: driftScene(), bypassValue: 0 });
    const b = (await tool("ae_patch_color_match").handler(colorArgs({ effect: "exposure", verify: false }), bypass.ctx)) as Out;
    expect(b.write.receipt.mismatches.map((m: any) => m.path)).toContain("effect.bypass");
  });

  it("returns the measurement, temp_comp and checkpoint instead of throwing when the write is refused", async () => {
    const ae = fakeAe({ scene: driftScene(), failFns: ["patchfitColorApply"] });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ verify: false }), ae.ctx)) as Out;
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/colour correction was not written/);
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(out).toHaveProperty("checkpoint");
    expect(out.drift.max_gain_change[0]).toBeGreaterThan(0.1);
  });
});

describe("review fixes: the grain tool", () => {
  it("passes the Remove Grain override to the host, apart from the grain effect's", async () => {
    const ae = fakeAe({ scene: grainScene() });
    await tool("ae_patch_grain").handler(grainArgs({ degrain: "remove_grain", degrain_viewing_mode_index: 5, rounds: 0, intensity: 0.2 }), ae.ctx);
    const apply = ae.calls.find((c) => c.fn === "patchfitGrainApply")!.args;
    expect(apply).toMatchObject({ degrain: "remove_grain", degrain_viewing_mode_index: 5 });
    expect(apply.viewing_mode_index).toBeUndefined();
  });

  it("returns what was measured when the first write is refused", async () => {
    const ae = fakeAe({ scene: grainScene(), failFns: ["patchfitGrainApply"] });
    const out = (await tool("ae_patch_grain").handler(grainArgs(), ae.ctx)) as Out;
    expect(out.ok).toBe(false);
    expect(out.grain_added).toBe(false);
    expect(out.message).toMatch(/grain was not written/);
    expect(out.sigma_before.plate_ring.spatial[0]).toBeGreaterThan(2);
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(ae.fns()).not.toContain("patchfitGrainTune");
  });

  it("keeps the applied grain and reports a tuning round that cannot be written", async () => {
    const ae = fakeAe({ scene: grainScene(), failFns: ["patchfitGrainTune"] });
    const out = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 2 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.grain_added).toBe(true);
    expect(out.write.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toMatch(/Tuning round 1 was not written/);
    expect(out.rounds[0].tune_failure).toMatch(/refused by the host/);
    expect(out.final_intensity).toBeCloseTo(out.start_intensity, 6);
  });

  it("flags a patch layer that setTrackMatte switched off and a grain layer that misses the patch's span", async () => {
    const off = fakeAe({ scene: grainScene(), patchState: { enabled: false }, rounds: 0 } as any);
    const o1 = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 0 }), off.ctx)) as Out;
    expect(o1.write.receipt.matches).toBe(false);
    expect(o1.write.receipt.mismatches.map((m: any) => m.path)).toContain("patch.enabled");
    const span = fakeAe({ scene: grainScene(), patchState: { in_point: 5, out_point: 8 } });
    const o2 = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 0 }), span.ctx)) as Out;
    expect(o2.write.receipt.mismatches.map((m: any) => m.path)).toContain("adjustment.span");
  });
});

describe("review fixes: the finish tool", () => {
  it("combines an earlier sit-in blur with the extra it measures (root of the sum of squares)", async () => {
    const info = { layer: { masks: [], effects: [{ index: 1, name: "Chroma sit-in blur", matchName: "ADBE Gaussian Blur 2" }] } };
    const base = fakeAe({ scene: finishScene(), info: { layer: { masks: [] } } });
    const b = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, edge: false, motion_blur: false, quality: false }), base.ctx)) as Out;
    const old = fakeAe({ scene: finishScene(), info, oldBlur: { value: 5 } });
    const n = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, edge: false, motion_blur: false, quality: false, replace_existing: true }), old.ctx)) as Out;
    expect(old.fns()).toContain("patchfitFinishState");
    // Per sampled time: the written amount is 2.5 x the root of (earlier sigma squared + extra sigma squared).
    const extras = n.measured.sharpness.sigma_px.map((x: any) => x.sigma);
    expect(extras.length).toBeGreaterThan(0);
    n.measured.sharpness.blurriness.forEach((v: number, i: number) => {
      near(v, 2.5 * Math.hypot(5 / 2.5, extras[i]), 0.02);
      expect(v).toBeGreaterThan(b.measured.sharpness.blurriness[i]);
    });
    expect(n.plan.blur.values.every((v: number) => v >= 2.5 * 2 - 0.01)).toBe(true);
    expect(n.measured.sharpness.existing_blurriness_at_ref).toBe(5);
    expect(n.notes.join(" ")).toMatch(/square root/);
  });

  it("plans the edge per mask: a mask with no expansion is not grown to the widest one's", async () => {
    const wide = { ...MASK, index: 2, name: "Mask 2", expansion: 30 };
    const keyed = { ...MASK, index: 3, name: "Mask 3", feather_keyed: true };
    const ae = fakeAe({ scene: finishScene(), info: { layer: { masks: [MASK, wide, keyed] } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, sharpness: false, motion_blur: false, quality: false }), ae.ctx)) as Out;
    const masks = out.plan.edge.masks;
    expect(masks.map((m: any) => m.index)).toEqual([1, 2]);
    expect(masks[0].expansion).toBe(masks[0].feather / 2);
    expect(masks[0].expansion).toBeLessThan(30);
    expect(masks[1].expansion).toBe(Math.max(30, masks[1].feather / 2));
    expect(out.notes.join(" ")).toMatch(/keyframed.*[(]3[)]/);
  });

  it("rounds the comp's shutter angle to whole degrees and reports the shutter phase", async () => {
    const ae = fakeAe({ scene: finishScene() });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, sharpness: false, edge: false, quality: false, shutter_angle: 172.8, allow_comp_change: true, track: movingTrack("trk_pf_shutter", 2) }), ae.ctx)) as Out;
    expect(out.plan.comp).toEqual({ motion_blur: true, shutter_angle: 173 });
    expect(out.measured.motion_blur.shutter_phase).toBe(-90);
    expect(out.measured.motion_blur.shutter_phase_note).toMatch(/not changed/);
  });

  it("returns the plan and the temp_comp fields when the write is refused", async () => {
    const ae = fakeAe({ scene: finishScene(), failFns: ["patchfitFinishApply"], info: { layer: { masks: [MASK] } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ track: movingTrack("trk_pf_fail", 2) }), ae.ctx)) as Out;
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/finish was not written/);
    expect(out.plan.blur).toBeDefined();
    expect(out.temp_comp.copy_removed).toBe(true);
  });
});

describe("review fixes: patchfit.jsx writes keep the earlier work when the new work fails", () => {
  const times = [0, 0.5, 1];
  const colorRun = (s: ReturnType<typeof scene>, extra: Record<string, unknown> = {}) => s.A.patchfitColorApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, mode: "levels", times, series: series("levels", times), expect: GUARD, ...extra });

  it("colour: a missing parameter or a failing setter leaves the earlier correction in place", () => {
    const s = scene();
    colorRun(s);
    const fx = s.fx as any;
    const original = fx.addProperty;
    fx.addProperty = (mn: string) => {
      const g = original(mn);
      g.property("Green Output Black").name = "Grün";
      return g;
    };
    expect(() => colorRun(s, { replace_existing: true })).toThrow(/Green Output Black/);
    expect(s.fx.props.map((p: any) => p.name)).toEqual([COLOR_EFFECT_NAME]);
    fx.addProperty = (mn: string) => {
      const g = original(mn);
      g.property("Blue Output White").setValuesAtTimes = () => {
        throw new Error("boom");
      };
      return g;
    };
    expect(() => colorRun(s, { replace_existing: true })).toThrow(/boom/);
    expect(s.fx.props.map((p: any) => p.name)).toEqual([COLOR_EFFECT_NAME]);
    // The earlier effect's keys are untouched.
    expect((s.fx.property(1) as any).property("Green Output Black").numKeys).toBe(3);
    fx.addProperty = original;
    const ok = colorRun(s, { replace_existing: true });
    expect(ok.replaced).toBe(true);
    expect(s.fx.props.map((p: any) => p.name)).toEqual([COLOR_EFFECT_NAME]);
  });

  it("colour: writes Individual Channels and the bypass value it set", () => {
    const s = scene();
    const on = colorRun(s, { mode: "exposure", series: series("exposure", times) });
    expect(on).toMatchObject({ channels_written: 2, bypass_written: 1 });
    const off = scene();
    const o = colorRun(off, { mode: "exposure", series: series("exposure", times), bypass_linear: false });
    expect(o).toMatchObject({ channels_written: 2, bypass_written: 0 });
  });

  const failingGrainParam = (s: ReturnType<typeof scene>) => {
    const original = (s.comp.layers as any).addSolid;
    (s.comp.layers as any).addSolid = (...a: any[]) => {
      const l = original(...a);
      const add = (l.property("ADBE Effect Parade") as any).addProperty;
      (l.property("ADBE Effect Parade") as any).addProperty = (mn: string) => {
        const g = add(mn);
        g.property("Intensity").name = "Stärke";
        return g;
      };
      return l;
    };
  };
  const grainRun = (s: ReturnType<typeof scene>, extra: Record<string, unknown> = {}) =>
    s.A.patchfitGrainApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, method: "add", degrain: "none", intensity: 0.4, expect: GUARD, ...extra });

  it("grain: a failed replacement keeps the earlier grain layer and degrain, and removes only what it added", () => {
    const s = scene();
    grainRun(s, { degrain: "median" });
    const oldId = (s.comp.layer("Patch GRAIN") as FakeLayer).id;
    failingGrainParam(s);
    expect(() => grainRun(s, { degrain: "median", replace_existing: true })).toThrow(/Add Grain is missing a parameter/);
    expect(s.comp.numLayers).toBe(3);
    expect((s.comp.layer("Patch GRAIN") as FakeLayer).id).toBe(oldId);
    expect(s.fx.props.map((p: any) => p.name)).toEqual(["Chroma degrain"]);
    expect(s.undo.begun).toBe(s.undo.ended);
  });

  it("grain: a viewing mode past the menu's last item is refused and everything added is taken back", () => {
    const s = scene();
    const original = (s.comp.layers as any).addSolid;
    (s.comp.layers as any).addSolid = (...a: any[]) => {
      const l = original(...a);
      const parade = l.property("ADBE Effect Parade") as any;
      const add = parade.addProperty;
      parade.addProperty = (mn: string) => {
        const g = add(mn);
        Object.assign(g.property("Viewing Mode"), { hasMin: true, minValue: 1, hasMax: true, maxValue: 2 });
        return g;
      };
      return l;
    };
    expect(() => grainRun(s, { degrain: "median" })).toThrow(/Add Grain's Viewing Mode: item 3 is past the menu's last item \(2\)/);
    expect(s.comp.numLayers).toBe(2);
    expect(s.fx.numProperties).toBe(0);
    // An override inside the menu works.
    const ok = grainRun(s, { viewing_mode_index: 2 });
    expect(ok.grain.viewing_mode_index).toBe(2);
    expect(() => grainRun(scene(), { viewing_mode_index: 0 })).toThrow(/whole number/);
    expect(() => grainRun(scene(), { degrain_viewing_mode_index: 1.5 })).toThrow(/whole number/);
  });

  it("grain: Remove Grain's Viewing Mode is checked against its own menu", () => {
    const s = scene();
    const fx = s.fx as any;
    const add = fx.addProperty;
    fx.addProperty = (mn: string) => {
      const g = add(mn);
      Object.assign(g.property("Viewing Mode"), { hasMax: true, maxValue: 3 });
      return g;
    };
    expect(() => grainRun(s, { degrain: "remove_grain" })).toThrow(/Remove Grain's Viewing Mode: item 4 is past the menu's last item \(3\)/);
    expect(s.fx.numProperties).toBe(0);
    expect(s.comp.numLayers).toBe(2);
    grainRun(s, { degrain: "remove_grain", degrain_viewing_mode_index: 3 });
    expect((s.fx.property(1) as any).property("Viewing Mode").staticValue).toBe(3);
  });

  it("grain: switches the patch back on when setTrackMatte hid it, and reports it", () => {
    const s = scene();
    const original = (s.comp.layers as any).addSolid;
    (s.comp.layers as any).addSolid = (...a: any[]) => {
      const l = original(...a);
      const matte = l.setTrackMatte;
      l.setTrackMatte = (m: FakeLayer, t: number) => {
        matte(m, t);
        m.enabled = false;
      };
      return l;
    };
    const out = grainRun(s);
    expect(s.patch.enabled).toBe(true);
    expect(out.patch_enabled).toBe(true);
    expect(out.notes.join(" ")).toMatch(/switched the patch layer off; it was switched back on/);
    const st = s.A.patchfitGrainState({ comp_id: s.comp.id, patch: { id: s.patch.id } });
    expect(st.patch).toMatchObject({ enabled: true, in_point: s.patch.inPoint, out_point: s.patch.outPoint });
    // A patch that was off before stays off.
    const t = scene();
    t.patch.enabled = false;
    const keep = grainRun(t);
    expect(t.patch.enabled).toBe(false);
    expect(keep.patch_enabled).toBe(false);
  });

  it("grain: the grain layer spans a patch that starts late, even where AE keeps the in point under the out point", () => {
    const s = scene();
    Object.assign(s.patch, { inPoint: 3, outPoint: 3.5 });
    const original = (s.comp.layers as any).addSolid;
    (s.comp.layers as any).addSolid = (...a: any[]) => {
      const l = original(...a);
      let inP = l.inPoint;
      let outP = l.outPoint;
      Object.defineProperty(l, "inPoint", {
        configurable: true,
        get: () => inP,
        set: (v: number) => {
          if (v > outP) throw new Error("the in point is past the out point");
          inP = v;
        },
      });
      Object.defineProperty(l, "outPoint", {
        configurable: true,
        get: () => outP,
        set: (v: number) => {
          if (v < inP) throw new Error("the out point is before the in point");
          outP = v;
        },
      });
      return l;
    };
    const out = grainRun(s);
    const adj = s.comp.layer("Patch GRAIN") as FakeLayer;
    expect([adj.inPoint, adj.outPoint]).toEqual([3, 3.5]);
    expect(out.notes).toEqual([]);
    const st = s.A.patchfitGrainState({ comp_id: s.comp.id, patch: { id: s.patch.id } });
    expect(st.adjustment).toMatchObject({ in_point: 3, out_point: 3.5 });
  });

  const finishRun = (s: ReturnType<typeof scene>, extra: Record<string, unknown>) => s.A.patchfitFinishApply({ comp_id: s.comp.id, layer: { id: s.patch.id }, expect: GUARD, ...extra });

  it("finish: a CC Force Motion Blur without its parameter takes the new blur back too and changes nothing else", () => {
    const s = scene(["planar.jsx", "patchfit.jsx"]);
    withEffects(s.patch, ["ADBE Corner Pin"]);
    finishRun(s, { blur: { times: [0], values: [2] } });
    const masks = s.patch.property("ADBE Mask Parade") as any;
    masks.addProperty("ADBE Mask Atom");
    masks.property(1).property("ADBE Mask Feather").setValue([1, 1]);
    const fx = s.fx as any;
    const original = fx.addProperty;
    fx.addProperty = (mn: string) => {
      const g = original(mn);
      if (mn === "CC Force Motion Blur") g.property("Shutter Angle").name = "Winkel";
      return g;
    };
    const names = () => s.fx.props.map((p: any) => p.name);
    const before = names();
    expect(() =>
      finishRun(s, { blur: { times: [0], values: [9], replace_existing: true }, force_motion_blur: { shutter_angle: 180 }, edge: { feather: 8, expansion: 4 }, layer_switches: { quality_best: true } })
    ).toThrow(/Shutter Angle/);
    expect(names()).toEqual(before);
    expect((s.fx.props.find((p: any) => p.name === "Chroma sit-in blur") as any).property("Blurriness").staticValue).toBe(2);
    expect(masks.property(1).property("ADBE Mask Feather").staticValue).toEqual([1, 1]);
    expect((s.patch as any).quality).toBe(1);
    expect(s.undo.begun).toBe(s.undo.ended);
  });

  it("finish: replacing the blur and the force motion blur renames the new ones and reports their final places", () => {
    const s = scene(["planar.jsx", "patchfit.jsx"]);
    withEffects(s.patch, ["ADBE Corner Pin"]);
    finishRun(s, { blur: { times: [0], values: [2] }, force_motion_blur: { shutter_angle: 90 } });
    const out = finishRun(s, { blur: { times: [0], values: [3], replace_existing: true }, force_motion_blur: { shutter_angle: 270, replace_existing: true } });
    const names = s.fx.props.map((p: any) => p.name);
    expect(names.filter((n: string) => n === "Chroma sit-in blur")).toHaveLength(1);
    expect(names.filter((n: string) => n === "Chroma force motion blur")).toHaveLength(1);
    expect(names.some((n: string) => n.endsWith("(new)"))).toBe(false);
    expect(out.blur.index).toBe(names.indexOf("Chroma sit-in blur") + 1);
    expect(out.force_motion_blur.index).toBe(names.indexOf("Chroma force motion blur") + 1);
    expect((s.fx.props.find((p: any) => p.name === "Chroma force motion blur") as any).property("Shutter Angle").staticValue).toBe(270);
  });

  it("finish: a setter that throws after the effects are made goes into notes and skipped, not out as an error", () => {
    const s = scene();
    const masks = s.patch.property("ADBE Mask Parade") as any;
    masks.addProperty("ADBE Mask Atom");
    masks.addProperty("ADBE Mask Atom");
    masks.property(2).property("ADBE Mask Feather").setValue = () => {
      throw new Error("the mask is locked");
    };
    Object.defineProperty(s.patch, "quality", {
      configurable: true,
      get: () => 1,
      set: () => {
        throw new Error("quality is locked");
      },
    });
    const out = finishRun(s, { blur: { times: [0], values: [2] }, edge: { feather: 6, expansion: 3 }, layer_switches: { quality_best: true, motion_blur: true } });
    expect(s.fx.props.map((p: any) => p.name)).toEqual(["Chroma sit-in blur"]);
    expect(out.edge.masks.map((m: any) => m.index)).toEqual([1]);
    expect(out.edge.skipped[0]).toMatchObject({ index: 2 });
    expect(out.edge.skipped[0].reason).toMatch(/mask is locked/);
    expect(out.notes.join(" ")).toMatch(/layer quality could not be set/);
    expect(out.layer_switches).toEqual({ motion_blur: true });
    expect(s.undo.begun).toBe(s.undo.ended);
  });

  it("finish: takes per-mask feather and expansion, and refuses a bad entry before the group opens", () => {
    const s = scene();
    const masks = s.patch.property("ADBE Mask Parade") as any;
    masks.addProperty("ADBE Mask Atom");
    masks.addProperty("ADBE Mask Atom");
    const out = finishRun(s, { edge: { masks: [{ index: 1, feather: 6, expansion: 3 }, { index: 2, feather: 2, expansion: 0 }, { index: 9, feather: 2, expansion: 0 }] } });
    expect(out.edge.masks).toEqual([{ index: 1, feather: 6, expansion: 3 }, { index: 2, feather: 2, expansion: 0 }]);
    expect(out.edge.skipped).toEqual([{ index: 9, reason: "the layer has no such mask" }]);
    expect(masks.property(1).property("ADBE Mask Offset").staticValue).toBe(3);
    expect(masks.property(2).property("ADBE Mask Offset").staticValue).toBe(0);
    const begun = s.undo.begun;
    expect(() => finishRun(s, { edge: { masks: [{ index: 0, feather: 2, expansion: 0 }] } })).toThrow(/mask number/);
    expect(() => finishRun(s, { edge: { masks: [] } })).toThrow(/1 to 50 entries/);
    expect(s.undo.begun).toBe(begun);
  });
});

describe("review fixes: patchfit.jsx lists past 50 effects", () => {
  it("reports up to 500 effects with the true count, finds its own effects and the pin beyond the list", () => {
    const s = scene();
    for (let i = 0; i < 519; i++) s.fx.addProperty("ADBE Gaussian Blur 2");
    (s.fx.property(510) as any).name = COLOR_EFFECT_NAME;
    s.fx.addProperty("ADBE Corner Pin");
    const out = s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id } });
    expect(out.layer.effects).toHaveLength(500);
    expect(out.layer.effects_total).toBe(520);
    expect(out.layer.effects_truncated).toBe(true);
    expect(out.layer.own_effects).toMatchObject({ color: 510, blur: null });
    expect(out.layer.pinned).toBe(true);
    const state = s.A.patchfitEffectState({ comp_id: s.comp.id, layer: { id: s.patch.id }, name: COLOR_EFFECT_NAME });
    expect(state.effects_total).toBe(520);
    expect(state.effect.index).toBe(510);
  });

  it("caps the plate list at 501 layers and says it was cut", () => {
    const s = scene();
    for (let i = 0; i < 600; i++) s.comp.layers.addSolid([0, 0, 0], `L${i}`, 10, 10, 1);
    const out = s.A.patchfitInfo({ comp_id: s.comp.id, layer: { id: s.patch.id } });
    expect(out.show).toHaveLength(501);
    expect(out.show_truncated).toBe(true);
    expect(out.total_layers).toBe(602);
  });
});

// ---------- wave 4 review fixes ----------

describe("wave 4 review fixes: patchfit", () => {
  const trackAt = (id: string, refK: number, okFrom = 0): PlanarTrack => {
    const frames = Array.from({ length: 10 }, (_, k) => ({ time: k / FPS, ok: k >= okFrom, H: k >= okFrom ? translate(2 * (k - refK), k - refK) : null, points: [], confidence: [], rms_px: 0, inliers: 1 }));
    return { version: 1, track_id: id, comp_id: 1, comp_size: [W, H], fps: FPS, ref_time: refK / FPS, model: "translate", ref_points: [[0, 0]], frames, source: "test", created: "" } as unknown as PlanarTrack;
  };
  const moveScene = (): Scene => ({ plate: (k, x, y, c) => GAIN(k)[c] * tex(x - 2 * k, y - k, c) + OFF(k)[c] * 255, patch: (_k, x, y, c) => tex(x, y, c) });

  it("smooths the ends without bias and keeps the reference frame the identity", () => {
    const ramp = Array.from({ length: 21 }, (_, i) => 1 + 0.02 * i);
    const sm = smoothGaussian(ramp, 3);
    near(sm[0], 1, 1e-9);
    near(sm[20], 1.4, 1e-9);
    const fit = (g: number): FrameFit => ({ ok: true, gain: [g, g, g], offset: [0.01, 0.01, 0.01], rms: 0, pixels: 100, visible: 1 });
    const curves = buildCurves(ramp.map(fit), { smoothFrames: 3, step: 1, refIndex: 0 })!;
    expect(curves.gain[0][0]).toBe(1);
    expect(curves.offset[0][0]).toBe(0);
    near(curves.gain[0][20], 1.4, 1e-9);
  });

  it("writes the identity at ref_time with the default smoothing", async () => {
    const ae = fakeAe({ scene: driftScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, smooth_frames: 3 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    const first = out.curves.samples[0];
    expect(first.time).toBe(0);
    expect(first.gain).toEqual([1, 1, 1]);
    expect(first.offset).toEqual([0, 0, 0]);
  });

  it("never saves a re-based copy over the user's stored track", async () => {
    const orig = trackAt("trk_pf_keep", 0);
    saveTrack(orig);
    const ae = fakeAe({ scene: moveScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, track: { track_id: "trk_pf_keep" }, ref_time: 3 / FPS }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    const after = loadTrack("trk_pf_keep")!;
    expect(after.ref_time).toBe(0);
    expect(after.frames[5].H).toEqual(orig.frames[5].H);
    expect(after.frames.every((f) => f.ok)).toBe(true);
  });

  it("defaults ref_time to the stored track's own reference frame and refuses a frame it has not solved", async () => {
    saveTrack(trackAt("trk_pf_ref", 2));
    const ae = fakeAe({ scene: moveScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, track: { track_id: "trk_pf_ref" } }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.ref_time).toBeCloseTo(2 / FPS, 4);
    // Solved from frame 5 on: an unsolved ref_time is refused and the stored track survives.
    saveTrack(trackAt("trk_pf_late", 5, 5));
    const late = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, track: { track_id: "trk_pf_late" }, ref_time: 0 }), fakeAe({ scene: moveScene() }).ctx)) as Out;
    expect(late.ok).toBe(false);
    expect(late.error).toBe("bad_args");
    const stored = loadTrack("trk_pf_late")!;
    expect(stored.ref_time).toBeCloseTo(5 / FPS, 6);
    expect(stored.frames.filter((f) => f.ok)).toHaveLength(5);
    const g = (await tool("ae_patch_grain").handler(grainArgs({ dry_run: true, track: { track_id: "trk_pf_late" }, ref_time: 0 }), fakeAe({ scene: grainScene() }).ctx)) as Out;
    expect(g.ok).toBe(false);
  });

  it("starts Match Grain at Intensity 1 and Add Grain from the measured sigma, and says which", async () => {
    const m = (await tool("ae_patch_grain").handler(grainArgs({ dry_run: true, method: "match", plate_layer: { index: 2 } }), fakeAe({ scene: grainScene() }).ctx)) as Out;
    expect(m.plan.start_intensity).toBe(1);
    const a = (await tool("ae_patch_grain").handler(grainArgs({ dry_run: true }), fakeAe({ scene: grainScene() }).ctx)) as Out;
    expect(a.plan.start_intensity).not.toBe(1);
    expect(tool("ae_patch_grain").description).toMatch(/1 for Match Grain/);
  });

  it("tunes the moving (temporal) grain when the patch is not degrained", async () => {
    const ae = fakeAe({ scene: grainScene() });
    const out = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 1 }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.rounds[0].metric).toBe("temporal");
    const spatial = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 1, degrain: "median" }), fakeAe({ scene: grainScene() }).ctx)) as Out;
    expect(spatial.rounds[0].metric).toBe("spatial");
  }, 60000);

  it("keeps the Intensity up when the patch holds frozen grain as strong as the plate's, and says the total is high", async () => {
    const frozen: Scene = {
      plate: (k, x, y, c) => tex(x, y, c) + SIGMA * randn(k, Math.round(x), Math.round(y), c, 5),
      patch: (_k, x, y, c) => tex(x, y, c) + SIGMA * randn(0, Math.round(x), Math.round(y), c, 9),
    };
    const out = (await tool("ae_patch_grain").handler(grainArgs({ rounds: 2 }), fakeAe({ scene: frozen }).ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.rounds[0].metric).toBe("temporal");
    expect(out.final_intensity).toBeGreaterThan(0.3 * out.start_intensity);
    expect(out.notes.join(" ")).toMatch(/degrain/);
  }, 60000);

  it("counts lost-track frames over every chunk and renders a failed frame again on the next call", async () => {
    const lostTrack = trackAt("trk_pf_lost2", 0);
    lostTrack.frames[7] = { ...lostTrack.frames[7], ok: false, H: null };
    lostTrack.frames[8] = { ...lostTrack.frames[8], ok: false, H: null };
    saveTrack(lostTrack);
    const failSnap = { time: 4 / FPS, times: 1 };
    const ae = fakeAe({ scene: moveScene(), failSnap });
    const h = tool("ae_patch_color_match").handler;
    let out = (await h(colorArgs({ track: { track_id: "trk_pf_lost2" }, max_renders: 4, dry_run: true, verify: false }), ae.ctx)) as Out;
    expect(out.complete).toBe(false);
    let guard = 0;
    while (!out.complete && guard++ < 12) {
      out = (await h(AePatchColorMatchSchema.parse({ comp_id: 1, continue_id: out.continue_id, max_renders: 4, dry_run: true, expect: expectArg, verify: false }), ae.ctx)) as Out;
    }
    expect(out.complete).toBe(true);
    expect(failSnap.times).toBe(0);
    // The glitched frame was measured by a later call, not given up on as a ring verdict.
    const row = out.curves.samples.find((s: { time: number }) => Math.abs(s.time - 4 / FPS) < 1e-6);
    expect(row.measured).toBe(true);
    expect(out.measured.lost_track_frames).toBe(2);
  }, 60000);

  it("measures at least one pending frame per call even when the reference render used the budget", async () => {
    const real = Date.now.bind(Date);
    let offset = 0;
    let snaps = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    try {
      // The time budget is gone as soon as the reference render is done.
      const ae = fakeAe({ scene: driftScene(), onSnap: (phase) => { if (phase === "before") offset = 0; else if (++snaps === 1) offset = 1e7; } });
      const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, max_renders: 4, max_seconds: 10 }), ae.ctx)) as Out;
      expect(out.progress.this_call).toBeGreaterThanOrEqual(1);
      expect(out.continue_id || out.complete).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect((AePatchColorMatchSchema as any)._def.schema.shape.max_renders.description).toMatch(/continue_id/);
    expect((AePatchGrainSchema as any)._def.schema.shape.max_renders.description).not.toMatch(/continue_id/);
  });

  it("keeps the blur cap in comp pixels on a scaled layer", async () => {
    const run = async (comp_scale?: { x: number; y: number; keyed: boolean; pinned: boolean }) => {
      const layer: Record<string, unknown> = { masks: [MASK] };
      if (comp_scale) layer.comp_scale = comp_scale;
      const ae = fakeAe({ scene: finishScene(), info: { layer } });
      return (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, edge: false, max_blur_sigma: 0.5, track: movingTrack("trk_pf_cap", 2) }), ae.ctx)) as Out;
    };
    const one = await run();
    const small = await run({ x: 0.21, y: 0.21, keyed: false, pinned: false });
    const big = await run({ x: 2, y: 2, keyed: false, pinned: false });
    for (const o of [one, small, big]) for (const x of o.measured.sharpness.sigma_px) expect(x.sigma).toBeLessThanOrEqual(0.5 + 1e-6);
    // The comp-pixel sigma does not depend on the layer's scale.
    expect(small.measured.sharpness.sigma_px[0].sigma).toBeCloseTo(one.measured.sharpness.sigma_px[0].sigma, 3);
    expect(big.measured.sharpness.sigma_px[0].sigma).toBeCloseTo(one.measured.sharpness.sigma_px[0].sigma, 3);
  });

  it("still reports the scale notes when only the edge is matched", async () => {
    const ae = fakeAe({ scene: finishScene(), info: { layer: { masks: [MASK], comp_scale: { x: 0.5, y: 0.5, keyed: false, pinned: true } } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, sharpness: false, edge: true, track: movingTrack("trk_pf_edgeonly", 2) }), ae.ctx)) as Out;
    expect(out.notes.join(" ")).toMatch(/pin's own scale/);
    expect(out.measured.edge.layer_scale).toBe(0.5);
  });

  it("uses a ref_time nested in the track source and reports the re-based copy", async () => {
    saveTrack(trackAt("trk_pf_nested", 2));
    const ae = fakeAe({ scene: moveScene() });
    const out = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, track: { track_id: "trk_pf_nested", ref_time: 4 / FPS } }), ae.ctx)) as Out;
    expect(out.ok).toBe(true);
    expect(out.ref_time).toBeCloseTo(4 / FPS, 4);
    expect(out.notes.join(" ")).toMatch(/re-based copy was saved as trk_/);
    expect(loadTrack("trk_pf_nested")!.ref_time).toBeCloseTo(2 / FPS, 6);
  }, 60000);

  it("converts the comp-pixel blur and feather to the patch layer's own pixels", async () => {
    const run = async (comp_scale?: { x: number; y: number; keyed: boolean; pinned: boolean }) => {
      const layer: Record<string, unknown> = { masks: [MASK] };
      if (comp_scale) layer.comp_scale = comp_scale;
      const ae = fakeAe({ scene: finishScene(), info: { layer } });
      return (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, track: movingTrack("trk_pf_scale", 2) }), ae.ctx)) as Out;
    };
    const one = await run();
    const half = await run({ x: 0.5, y: 0.5, keyed: false, pinned: false });
    expect(half.plan.blur.values[0] / one.plan.blur.values[0]).toBeGreaterThan(1.8);
    expect(half.plan.blur.values[0] / one.plan.blur.values[0]).toBeLessThan(2.2);
    expect(half.plan.edge.masks[0].feather / one.plan.edge.masks[0].feather).toBeGreaterThan(1.8);
    expect(half.measured.sharpness.layer_scale).toBe(0.5);
    expect(half.notes.join(" ")).toMatch(/scaled to 0.5x/);
    const pinned = await run({ x: 1, y: 1, keyed: false, pinned: true });
    expect(pinned.notes.join(" ")).toMatch(/pin's own scale/);
  });
  it("reports the re-based copy on every return, not only the finished one, and gives no delete advice", async () => {
    // Finished run.
    saveTrack(trackAt("trk_pf_rep1", 2));
    const done = (await tool("ae_patch_color_match").handler(colorArgs({ dry_run: true, track: { track_id: "trk_pf_rep1", ref_time: 4 / FPS } }), fakeAe({ scene: moveScene() }).ctx)) as Out;
    expect(done.ok).toBe(true);
    expect(done.rebased_track.from).toBe("trk_pf_rep1");
    expect(done.rebased_track.track_id).toMatch(/^trk_/);
    expect(done.rebased_track.track_id).not.toBe("trk_pf_rep1");
    expect(done.notes.join(" ")).not.toMatch(/delete copies/);
    expect(done.notes.join(" ")).toMatch(/newest 200/);

    // A chunked run: the copy is reported on the unfinished return too, and on the call that finishes.
    saveTrack(trackAt("trk_pf_rep2", 2));
    const h = tool("ae_patch_color_match").handler;
    let out = (await h(colorArgs({ dry_run: true, track: { track_id: "trk_pf_rep2", ref_time: 4 / FPS }, max_renders: 4, verify: false }), fakeAe({ scene: moveScene() }).ctx)) as Out;
    expect(out.complete).toBe(false);
    const copyId = out.rebased_track.track_id;
    expect(out.rebased_track.from).toBe("trk_pf_rep2");
    let guard = 0;
    const ae = fakeAe({ scene: moveScene() });
    while (!out.complete && guard++ < 12) {
      out = (await h(AePatchColorMatchSchema.parse({ comp_id: 1, continue_id: out.continue_id, max_renders: 4, dry_run: true, expect: expectArg, verify: false }), ae.ctx)) as Out;
      expect(out.rebased_track.track_id).toBe(copyId);
    }
    expect(out.complete).toBe(true);
    expect(out.rebased_track.from).toBe("trk_pf_rep2");

    // not_measurable: only the new reference frame is solved, so fewer than two frames can be fitted.
    const lone = trackAt("trk_pf_rep3", 4);
    lone.frames = lone.frames.map((f, k) => (k === 3 ? f : { ...f, ok: false, H: null }));
    saveTrack(lone);
    const nm = (await h(colorArgs({ dry_run: true, track: { track_id: "trk_pf_rep3", ref_time: 3 / FPS } }), fakeAe({ scene: moveScene() }).ctx)) as Out;
    expect(nm.error).toBe("not_measurable");
    expect(nm.rebased_track.from).toBe("trk_pf_rep3");

    // measure_failed: the reference render throws.
    saveTrack(trackAt("trk_pf_rep4", 2));
    const mf = (await h(colorArgs({ dry_run: true, track: { track_id: "trk_pf_rep4", ref_time: 4 / FPS } }), fakeAe({ scene: moveScene(), failSnap: { time: 4 / FPS, times: 99 } }).ctx)) as Out;
    expect(mf.error).toBe("measure_failed");
    expect(mf.rebased_track.from).toBe("trk_pf_rep4");

    // A track of the same reference frame needs no copy and reports none.
    saveTrack(trackAt("trk_pf_rep5", 2));
    const same = (await h(colorArgs({ dry_run: true, track: { track_id: "trk_pf_rep5" } }), fakeAe({ scene: moveScene() }).ctx)) as Out;
    expect(same.ok).toBe(true);
    expect(same.rebased_track).toBeUndefined();
  }, 120000);

  it("words the scale note for what the finish tool will write, not what it did", async () => {
    const ae = fakeAe({ scene: finishScene(), info: { layer: { masks: [MASK], comp_scale: { x: 0.5, y: 0.5, keyed: false, pinned: false } } } });
    const out = (await tool("ae_patch_finish").handler(finishArgs({ dry_run: true, track: movingTrack("trk_pf_wording", 2) }), ae.ctx)) as Out;
    const text = out.notes.join(" ");
    expect(text).toMatch(/scaled to 0.5x/);
    expect(text).toMatch(/are divided by it before they are written/);
    expect(text).not.toMatch(/were divided/);
  });

  it("says the grain tuning rounds render on top of max_renders", () => {
    const d = (AePatchGrainSchema as any)._def.schema.shape.max_renders.description as string;
    expect(d).toMatch(/tuning rounds render on top/);
    expect((AePatchColorMatchSchema as any)._def.schema.shape.max_renders.description).not.toMatch(/tuning rounds/);
  });
});
