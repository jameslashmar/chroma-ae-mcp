import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyH, identityH, invertH, mulH, type Mat3, type PlanarFrame, type PlanarTrack, type Vec2 } from "../src/tools/ext/planar-math.js";
import { saveTrack } from "../src/tools/ext/planar.js";
import { AeTrackJoinSchema, joinQuad, joinTracks, trackJoinTools } from "../src/tools/ext/track-join.js";
import type { ToolContext } from "../src/tools/common.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-trackjoin-"));
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

const FPS = 10;
const QUAD: Vec2[] = [[300, 200], [700, 220], [690, 520], [310, 500]];

/** Scale s about (cx, cy), then a shift. */
const sim = (s: number, tx: number, ty: number, cx = 500, cy = 360): Mat3 => [s, 0, cx - s * cx + tx, 0, s, cy - s * cy + ty, 0, 0, 1];

/** The surface's motion from the base's reference (frame 15): a dolly out from 2.5x at frame 0 to 1x at 15 and on. */
const motion = (k: number): Mat3 => (k >= 15 ? sim(1 - 0.01 * (k - 15), 3 * (k - 15), 1 * (k - 15)) : sim(1 + (1.5 * (15 - k)) / 15, 2 * (k - 15), 0));

function track(id: string, refK: number, okFrom: number, okTo: number, H: (k: number) => Mat3, quad = QUAD): PlanarTrack {
  const frames: PlanarFrame[] = [];
  for (let k = 0; k <= 25; k++) {
    const ok = k >= okFrom && k <= okTo;
    frames.push({ time: k / FPS, ok, H: ok ? H(k) : null, points: [], confidence: [], rms_px: null, inliers: 0, ...(ok ? {} : { note: "not solved" }) });
  }
  return { version: 1, track_id: id, comp_id: 1, comp_size: [1000, 720], fps: FPS, ref_time: refK / FPS, model: "perspective", ref_points: quad, frames, source: "test", created: "now" };
}

/**
 * The base tracks frames 8-25 from frame 15; the add tracks 0-12 from frame 3, whose reference relates to the
 * base's by G0. The add can drift by `drift` px a frame in the picture, zero at frame 10: on the shared frames
 * 8-12 the two then disagree by 2d, d, 0, d, 2d (a constant offset would just be absorbed into the relation).
 */
const G0 = invertH(motion(3))!;
const base = () => track("trk_join_base", 15, 8, 25, motion);
const add = (drift = 0) => track("trk_join_add", 3, 0, 12, (k) => mulH(sim(1, drift * (k - 10), 0), mulH(motion(k), invertH(G0)!)), QUAD.map((p) => applyH(G0, p)!) as Vec2[]);

const cornersAt = (f: PlanarFrame, quad = QUAD) => quad.map((c) => applyH(f.H!, c)!);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("joinTracks", () => {
  it("carries the add's frames into the base's reference exactly when the two agree", () => {
    const { frames, report } = joinTracks(base(), add(), { limitPx: 2, blendFrames: 3 });
    expect(report.shared_frames).toBe(5);
    expect(report.disagreement_px.median).toBeLessThan(0.01);
    expect(report.frames).toMatchObject({ base: 18, add_only: 8, neither: 0 });
    expect(frames).toHaveLength(26);
    for (const f of frames) {
      expect(f.ok).toBe(true);
      const k = Math.round(f.time * FPS);
      cornersAt(f).forEach((c, i) => expect(dist(c, applyH(motion(k), QUAD[i])!)).toBeLessThan(0.01));
    }
    expect(report.seams).toEqual([0.8]);
  });

  it("blends over the shared frames next to the seam, so the hand-over does not jump", () => {
    const { frames, report } = joinTracks(base(), add(0.4), { limitPx: 2, blendFrames: 3 });
    expect(report.disagreement_px.median).toBeCloseTo(0.4, 2);
    expect(report.disagreement_px.max).toBeCloseTo(0.8, 2);
    // The add's drift where only it solved (-1.2 px at frame 7), then 3/4, 2/4 and 1/4 of the add's own offset
    // on the base's first shared frames (-0.8, -0.4, 0 there), then the base's own.
    const off = frames.map((f) => cornersAt(f)[0][0] - applyH(motion(Math.round(f.time * FPS)), QUAD[0])![0]);
    expect(off[7]).toBeCloseTo(-1.2, 3);
    expect(off[8]).toBeCloseTo(-0.6, 3);
    expect(off[9]).toBeCloseTo(-0.2, 3);
    expect(off[10]).toBeCloseTo(0, 3);
    expect(off[11]).toBeCloseTo(0, 3);
    expect(report.frames.blended).toBe(3);
    // Without the blend the hand-over jumps the whole 1.2 px.
    const raw = joinTracks(base(), add(0.4), { limitPx: 2, blendFrames: 0 }).frames.map((f) => cornersAt(f)[0][0] - applyH(motion(Math.round(f.time * FPS)), QUAD[0])![0]);
    expect(Math.abs(raw[8] - raw[7])).toBeCloseTo(1.2, 3);
    expect(Math.abs(off[8] - off[7])).toBeLessThan(0.7);
  });

  it("refuses two tracks that share under 3 solved frames, or that disagree", () => {
    const short = track("trk_join_short", 3, 0, 9, (k) => mulH(motion(k), invertH(G0)!), QUAD.map((p) => applyH(G0, p)!) as Vec2[]);
    expect(() => joinTracks(base(), short, { limitPx: 2, blendFrames: 3 })).toThrow(/share 2 solved frame/);
    expect(() => joinTracks(base(), add(3), { limitPx: 2, blendFrames: 3 })).toThrow(/disagree.*median 3 px/);
  });

  it("says how far the relation's error is carried, and that the other way round would carry less", () => {
    // The add's frames show the surface up to 2.5 times larger than the shared frames (a close-up taken from the add).
    const { report } = joinTracks(base(), add(0.5), { limitPx: 2, blendFrames: 3 });
    // 2.5x at frame 0 against a median 1.5x on the shared frames 8-12.
    expect(report.carried.ratio_add).toBeCloseTo(2.5 / 1.5, 1);
    expect(report.carried.carried_px).toBeCloseTo(report.carried.ratio_add * 0.5, 1);
    // Swapped, the base-only frames (the wide end, about 1x) would take it.
    expect(report.carried.ratio_swapped).toBeLessThan(0.85);
    expect(report.carried.swapped_px).toBeLessThan(report.carried.carried_px / 1.5);
  });

  it("measures and blends at the base's quad, or the box of its points", () => {
    expect(joinQuad(base())).toEqual(QUAD);
    const pts = { ...base(), ref_points: [[10, 20], [50, 25], [30, 70]] as Vec2[] };
    expect(joinQuad(pts)).toEqual([[10, 20], [50, 20], [50, 70], [10, 70]]);
  });
});

describe("ae_track_join (the tool)", () => {
  const ctx = { bridge: { newOpId: () => "op_test" } } as unknown as ToolContext;
  const run = (extra: Record<string, unknown>) => trackJoinTools[0].handler(AeTrackJoinSchema.parse({ comp_id: 1, ...extra }), ctx) as Promise<Record<string, any>>;

  it("saves the joined track and reports the join, the seams and the path check", async () => {
    saveTrack(base());
    saveTrack(add(0.5));
    const out = await run({ base: { track_id: "trk_join_base" }, add: { track_id: "trk_join_add" }, max_disagreement_px: 3 });
    expect(out.ok).toBe(true);
    expect(out.track_id).toMatch(/^trk_/);
    expect(out.frames_ok).toBe(26);
    expect(out.ref_time).toBe(1.5);
    expect(out.join.shared_frames).toBe(5);
    expect(out.path_check.frames_checked).toBeGreaterThan(9);
    // The close-up came from the add: the note says to swap.
    expect(out.notes.join(" ")).toMatch(/other way round/);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, fs.readdirSync(dataDir).includes("chroma-ae-mcp") ? "chroma-ae-mcp" : "", "tracks", `${out.track_id}.json`), "utf8"));
    expect(stored.source).toMatch(/join of trk_join_base \(base\) and trk_join_add/);
    expect(stored.frames.find((f: PlanarFrame) => Math.abs(f.time - 1.5) < 1e-6).H).toEqual(identityH());
  });

  it("refuses tracks of different comp sizes, and a join that disagrees", async () => {
    saveTrack({ ...add(), track_id: "trk_join_other", comp_size: [640, 360] });
    expect(await run({ base: { track_id: "trk_join_base" }, add: { track_id: "trk_join_other" } })).toMatchObject({ ok: false, error: "refused" });
    saveTrack({ ...add(6), track_id: "trk_join_far" });
    const far = await run({ base: { track_id: "trk_join_base" }, add: { track_id: "trk_join_far" } });
    expect(far).toMatchObject({ ok: false, error: "refused" });
    expect(far.message).toMatch(/disagree/);
  });
});
