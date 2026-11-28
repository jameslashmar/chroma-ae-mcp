/**
 * A perspective track on points in a thin band, under a much larger surface: the case from a 4K shot
 * (2026-11-26) where the points moved under 1 px a frame and the surface corners jumped up to 35 px.
 * The same points solved with fewer parameters hold the corners; ae_track_apply writes that
 * (refit_model) or a smoothed copy (smooth_frames) without tracking again.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjustTrack, cornerJitter, loadTrack, modelAdvice, pointsCover, trackSummary } from "../src/tools/ext/planar.js";
import { applyH, refitFrames, solveModel, type Mat3, type PlanarFrame, type PlanarTrack, type Vec2 } from "../src/tools/ext/planar-math.js";

// The shot's own layout: 8 points in a 1569 x 284 px band, the surface 2309 x 761 px around them.
const REF: Vec2[] = [[1493.5, 316.5], [1176.5, 390.5], [1790.5, 475.5], [1539.5, 600.5], [981.5, 596.5], [2550.5, 580.5], [1268.5, 598.5], [2356.5, 461.5]];
const QUAD: Vec2[] = [[835, 187], [3144, 187], [3144, 948], [835, 948]];

let dataDir: string;
const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-track-advice-"));
  process.env.LOCALAPPDATA = dataDir;
  process.env.HOME = dataDir;
  process.env.XDG_DATA_HOME = dataDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Seeded Gaussian noise. */
function gauss(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** A slow pan and zoom (the shot: about 6% zoom and 125 px over 54 frames at 25 fps), points tracked with 0.6 px noise (the shot's first half had about 1 px), solved as perspective. */
function thinBandTrack(noisePx = 0.6): PlanarTrack {
  const n = 54;
  const g = gauss(7);
  const refIdx = n - 1;
  const frames: PlanarFrame[] = [];
  for (let i = 0; i < n; i++) {
    const u = (refIdx - i) / refIdx;
    const s = 1 - 0.06 * u;
    const truth: Mat3 = [s, 0, 125 * u, 0, s, 18 * u, 0, 0, 1];
    if (i === refIdx) {
      frames.push({ time: i / 25, ok: true, H: [1, 0, 0, 0, 1, 0, 0, 0, 1], points: REF.map((p) => [...p] as Vec2), confidence: REF.map(() => 1), rms_px: 0, inliers: REF.length });
      continue;
    }
    const pts = REF.map((p) => {
      const q = applyH(truth, p)!;
      return [q[0] + noisePx * g(), q[1] + noisePx * g()] as Vec2;
    });
    const sol = solveModel("perspective", REF, pts)!;
    frames.push({ time: i / 25, ok: true, H: sol.H, points: pts, confidence: REF.map(() => 0.95), rms_px: sol.rms_px, inliers: REF.length });
  }
  return {
    version: 1,
    track_id: "trk_test_band",
    comp_id: 1,
    comp_size: [3840, 2160],
    fps: 25,
    ref_time: refIdx / 25,
    model: "perspective",
    ref_points: REF,
    frames,
    source: "ae_track_multi",
    created: "2026-11-26T14:48:22.543Z",
    tracking: {
      options: { model: "perspective" },
      range: { start: 0, end: n / 25 },
      quad: QUAD,
      forward: { done: true, next_time: null, stop: null, last_points: [], last_H: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      backward: { done: true, next_time: null, stop: null, last_points: [], last_H: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      dropped: [],
    },
  };
}

describe("a perspective track on points in a thin band", () => {
  it("shakes its corners many times more than its points, which the summary says, with the model to write with", () => {
    const t = thinBandTrack();
    const jitter = cornerJitter(t, QUAD)!;
    expect(jitter).toBeGreaterThan(2);
    expect(pointsCover(REF, QUAD)).toEqual({ width_pct: 68, height_pct: 37 });
    const advice = modelAdvice(t)!;
    expect(advice.recommended).toEqual({ refit_model: expect.stringMatching(/affine|similarity/) });
    const best = (advice.tried as Array<{ model: string; corner_jitter_px: number }>).find((x) => x.model === (advice.recommended as { refit_model: string }).refit_model)!;
    expect(best.corner_jitter_px).toBeLessThan(jitter / 4);
    expect(advice.note).toMatch(/span 68% of the surface's width and 37% of its height.*refit_model: "(affine|similarity)"/);
    expect(trackSummary(t).model_advice).toEqual(advice);
  });

  it("refitFrames keeps the tracked points and the reference frame, and only changes H", () => {
    const t = thinBandTrack();
    const a = refitFrames(t, "affine");
    expect(a.model).toBe("affine");
    expect(a.frames.every((f) => f.ok)).toBe(true);
    expect(a.frames.map((f) => f.points)).toEqual(t.frames.map((f) => f.points));
    const ref = a.frames[a.frames.length - 1];
    ref.H!.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 9));
    // affine has no perspective terms, and it still fits the points to about their noise (0.6 px per axis, 0.85 px as a distance)
    expect(a.frames.every((f) => f.H![6] === 0 && f.H![7] === 0)).toBe(true);
    expect(Math.max(...a.frames.map((f) => f.rms_px ?? 0))).toBeLessThan(1.2);
    expect(a.frames.filter((f) => typeof f.expected_px === "number").length).toBeGreaterThan(40);
  });

  it("no advice for a steady track, or a model with nothing below it to try", () => {
    expect(modelAdvice(thinBandTrack(0))).toBeNull();
    expect(modelAdvice({ ...refitFrames(thinBandTrack(), "similarity") })).toBeNull();
  });

  it("adjustTrack (ae_track_apply refit_model, smooth_frames) saves a new track and reports the shake before and after", () => {
    const t = thinBandTrack();
    const { track, info } = adjustTrack(t, { refit_model: "affine", smooth_frames: 1.5 });
    expect(track.track_id).not.toBe(t.track_id);
    expect(track.model).toBe("affine");
    expect(info).toMatchObject({ from_track_id: "trk_test_band", track_id: track.track_id, model: "affine", smooth_frames: 1.5, frames_ok: { before: 54, after: 54 } });
    const j = info!.corner_jitter_px as { before: number; after: number };
    expect(j.after).toBeLessThan(j.before / 8);
    expect(String(info!.note)).toMatch(/refit perspective -> affine, smoothed over 1.5 frame\(s\).*trk_test_band is unchanged/);
    expect(loadTrack(track.track_id)?.source).toMatch(/from trk_test_band/);
    expect(adjustTrack(t, {})).toEqual({ track: t, info: null });
    // smoothing alone keeps the model
    const sm = adjustTrack(t, { smooth_frames: 2 });
    expect(sm.track.model).toBe("perspective");
    expect((sm.info!.corner_jitter_px as { after: number }).after).toBeLessThan(j.before);
  });
});
