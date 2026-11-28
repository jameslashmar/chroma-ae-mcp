/**
 * server/src/tools/ext/track-join.ts
 *
 * ae_track_join: one planar track from two tracks of the same surface made from different reference frames.
 *
 * A region or screen track compares every frame with ONE reference frame. Where the surface's size on screen
 * changes a lot (a close-up that pulls back to a wide shot), a reference from one end is too small or too large
 * for the other end: on Hollywood Camera Work's Painting plate a reference in the wide shot (the board 3-4 times
 * smaller) correlated 0.76-0.81 with the close-up frames (0.85 needed), and the track stopped there. Trackers
 * answer this with several reference frames (Nuke's keyframes, Mocha's reference frames, Silhouette's merge,
 * docs/TRACKING-RESEARCH.md 1.2): here, track the hard stretch with a reference of its own, then join.
 *
 * How: on the frames both tracks solved, H_add(t)^-1 . H_base(t) maps the base's reference onto the add's; it
 * must be the same on every such frame if both are right. Its robust median (a grid over the base's quad, the
 * median of each grid point's place, a homography fitted to them) carries the add's frames into the base's
 * reference. How far the two disagree is measured in the FRAME's pixels at the base's corners, frame by frame,
 * and a join where they disagree is refused. The base is kept where it solved; where it hands over to the add
 * (or back), the corners are blended over the shared frames next to the seam, so the join does not jump.
 */

import { z } from "zod";
import { type ToolContext, type ToolDefinition } from "../common.js";
import { checkPaths } from "./path-check.js";
import { applyH, identityH, invertH, mulH, solveModel, type Mat3, type PlanarFrame, type PlanarTrack, type Vec2 } from "./planar-math.js";
import { newTrackId, PlanarError, resolveTrackSource, saveTrack, TrackSourceSchema } from "./planar.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const failure = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });

export const AeTrackJoinSchema = z.object({
  comp_id: z.number().int(),
  base: TrackSourceSchema.describe("The track whose reference frame and corners the result keeps (usually the one that covers most of the shot)."),
  add: TrackSourceSchema.describe("A track of the same surface from another reference frame, covering frames the base did not solve. The two must share at least 3 solved frames."),
  max_disagreement_px: z
    .number()
    .min(0.1)
    .max(50)
    .default(2)
    .describe("How far the two tracks may put the base's corners apart on the frames both solved (median over those frames), px at 1080 lines. Default 2. Over it the join is refused: one of them is wrong there."),
  blend_frames: z.number().int().min(0).max(48).default(8).describe("Shared frames next to a seam over which the corners are blended from one track to the other. Default 8."),
});

export type AeTrackJoinArgs = z.infer<typeof AeTrackJoinSchema>;

/** The corners the join is measured and blended at: the base's quad when it has one, else the box of its points. */
export function joinQuad(t: PlanarTrack): Vec2[] {
  const q = (t.tracking?.quad as Vec2[] | undefined) ?? (t.ref_points.length === 4 ? t.ref_points : null);
  if (q && q.length === 4) return q;
  const xs = t.ref_points.map((p) => p[0]);
  const ys = t.ref_points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** A 3 x 3 grid over a quad (bilinear), for a fit that does not lean on four points alone. */
function gridOver(q: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const v of [0, 0.5, 1]) {
    for (const u of [0, 0.5, 1]) {
      const top: Vec2 = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
      const bot: Vec2 = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
      out.push([top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v]);
    }
  }
  return out;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface JoinReport {
  shared_frames: number;
  /** Per shared frame: the largest distance between the two tracks' corners, frame px. */
  disagreement_px: { median: number; max: number; worst: Array<{ time: number; px: number }> };
  /** Frames solved by the base, by the add only, and by neither, in the joined range. */
  frames: { base: number; add_only: number; neither: number; blended: number };
  seams: number[];
  /**
   * The relation is measured where the two overlap; on a frame where the surface shows `ratio` times larger
   * than there, its error grows by that much. carried_px: the median disagreement times the largest such ratio
   * over the frames taken from the add; swapped_px: the same if base and add were swapped (the base-only frames
   * would then take it).
   */
  carried: { ratio_add: number; carried_px: number; ratio_swapped: number; swapped_px: number };
}

/** The base quad's size in a frame, px: the square root of its area there. */
function sizeIn(H: Mat3, quad: Vec2[]): number | null {
  const q = quad.map((c) => applyH(H, c));
  if (q.some((p) => p === null)) return null;
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i]!;
    const n = q[(i + 1) % 4]!;
    a += p[0] * n[1] - n[0] * p[1];
  }
  return Math.sqrt(Math.abs(a) / 2);
}

/**
 * Joins `add` into `base`'s reference. Pure: returns the joined frames and the report, or throws a PlanarError
 * when the tracks share too few frames or disagree. `limitPx` is in frame px.
 */
export function joinTracks(base: PlanarTrack, add: PlanarTrack, opts: { limitPx: number; blendFrames: number }): { frames: PlanarFrame[]; report: JoinReport; G: Mat3 } {
  const fps = base.fps > 0 ? base.fps : 25;
  const key = (t: number) => Math.round(t * fps);
  const bAt = new Map(base.frames.map((f) => [key(f.time), f]));
  const aAt = new Map(add.frames.map((f) => [key(f.time), f]));
  const good = (f: PlanarFrame | undefined): f is PlanarFrame & { H: Mat3 } => !!f && f.ok && !!f.H;
  const shared = [...bAt.keys()].filter((k) => good(bAt.get(k)) && good(aAt.get(k))).sort((a, b) => a - b);
  if (shared.length < 3) {
    throw new PlanarError(
      "refused",
      `The two tracks share ${shared.length} solved frame(s); a join needs 3 or more to measure how they relate. Track one of them further (continue_track_id, or a longer start/end) so that both solve the same stretch.`
    );
  }
  const quad = joinQuad(base);
  const grid = gridOver(quad);
  // Each shared frame's map from the base's reference to the add's: H_add^-1 . H_base.
  const placed: Vec2[][] = [];
  for (const k of shared) {
    const inv = invertH(aAt.get(k)!.H!);
    if (!inv) continue;
    const Gk = mulH(inv, bAt.get(k)!.H!);
    const pts = grid.map((p) => applyH(Gk, p));
    if (pts.some((p) => p === null)) continue;
    placed.push(pts as Vec2[]);
  }
  if (placed.length < 3) throw new PlanarError("refused", "The shared frames could not relate the two tracks (a degenerate motion on most of them).");
  const target = grid.map((_, i) => [median(placed.map((p) => p[i][0])), median(placed.map((p) => p[i][1]))] as Vec2);
  const fit = solveModel("perspective", grid, target);
  if (!fit) throw new PlanarError("refused", "The relation between the two tracks' reference frames could not be solved.");
  const G = fit.H;
  // How far apart the two put the base's corners on each shared frame, in that frame's px.
  const dis: Array<{ k: number; px: number }> = [];
  for (const k of shared) {
    const Hb = bAt.get(k)!.H!;
    const Ha = mulH(aAt.get(k)!.H!, G);
    let m = 0;
    for (const c of quad) {
      const p = applyH(Hb, c);
      const q = applyH(Ha, c);
      if (!p || !q) continue;
      m = Math.max(m, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
    dis.push({ k, px: m });
  }
  const med = median(dis.map((d) => d.px));
  if (med > opts.limitPx) {
    const worst = [...dis].sort((a, b) => b.px - a.px).slice(0, 5).map((d) => `${r2(d.k / fps)} s: ${r2(d.px)} px`);
    throw new PlanarError(
      "refused",
      `The two tracks disagree on the frames both solved: they put the base's corners a median ${r2(med)} px apart (limit ${r2(opts.limitPx)}; worst ${worst.join(", ")}). One of them is off there: check both on their previews, or track the surface again with a reference nearer the shared frames.`
    );
  }
  // The joined frames: the base where it solved; the add, carried into the base's reference, where only it did.
  const all = [...new Set([...bAt.keys(), ...aAt.keys()])].sort((a, b) => a - b);
  const source = new Map<number, "base" | "add" | "none">();
  for (const k of all) source.set(k, good(bAt.get(k)) ? "base" : good(aAt.get(k)) ? "add" : "none");
  // Seams: where an add-only stretch meets base frames. The base's frames next to it that the add also solved
  // are blended from the add to the base, so the hand-over does not jump.
  const seams: number[] = [];
  const blendW = new Map<number, number>();
  const sharedSet = new Set(shared);
  for (let i = 0; i < all.length; i++) {
    if (source.get(all[i]) !== "add") continue;
    for (const dir of [1, -1]) {
      const n = all[i + dir];
      if (n === undefined || source.get(n) !== "base") continue;
      seams.push(n);
      let j = i + dir;
      let step = 1;
      while (step <= opts.blendFrames && all[j] !== undefined && sharedSet.has(all[j]) && source.get(all[j]) === "base") {
        const w = step / (opts.blendFrames + 1);
        // The weight of the base: 1 / (n + 1) next to the seam, rising to 1 past the blend.
        blendW.set(all[j], Math.min(blendW.get(all[j]) ?? 1, w));
        j += dir;
        step++;
      }
    }
  }
  const out: PlanarFrame[] = [];
  let blended = 0;
  for (const k of all) {
    const src = source.get(k)!;
    const time = r4(k / fps);
    if (src === "none") {
      const f = bAt.get(k) ?? aAt.get(k)!;
      out.push({ ...f, time, ok: false, H: null, note: f.note ?? "neither track solved this frame" });
      continue;
    }
    if (src === "add") {
      const fa = aAt.get(k)!;
      out.push({ ...fa, time, ok: true, H: mulH(fa.H!, G), points: [], confidence: [], note: undefined });
      continue;
    }
    const fb = bAt.get(k)!;
    const w = blendW.get(k);
    if (w === undefined || !good(aAt.get(k))) {
      out.push({ ...fb, time });
      continue;
    }
    // Blend the corners: w of the base, 1 - w of the add carried over; the homography through the blended corners.
    const Ha = mulH(aAt.get(k)!.H!, G);
    const from: Vec2[] = [];
    const to: Vec2[] = [];
    for (const c of quad) {
      const p = applyH(fb.H!, c);
      const q = applyH(Ha, c);
      if (!p || !q) continue;
      from.push(c);
      to.push([w * p[0] + (1 - w) * q[0], w * p[1] + (1 - w) * q[1]]);
    }
    const s = from.length === 4 ? solveModel("perspective", from, to) : null;
    if (s) blended++;
    out.push({ ...fb, time, H: s ? s.H : fb.H });
  }
  const worst = [...dis].sort((a, b) => b.px - a.px).slice(0, 5).map((d) => ({ time: r4(d.k / fps), px: r2(d.px) }));
  // How much larger the surface shows on the frames taken from either side than on the shared ones.
  const sharedSize = median(shared.map((k) => sizeIn(bAt.get(k)!.H!, quad)).filter((v): v is number => v !== null));
  const sizes = (keys: number[], H: (k: number) => Mat3) => keys.map((k) => sizeIn(H(k), quad)).filter((v): v is number => v !== null);
  const addOnly = all.filter((k) => source.get(k) === "add");
  const baseOnly = all.filter((k) => source.get(k) === "base" && !sharedSet.has(k));
  const ratioAdd = addOnly.length && sharedSize > 0 ? Math.max(...sizes(addOnly, (k) => mulH(aAt.get(k)!.H!, G))) / sharedSize : 0;
  const ratioSwap = baseOnly.length && sharedSize > 0 ? Math.max(...sizes(baseOnly, (k) => bAt.get(k)!.H!)) / sharedSize : 0;
  return {
    frames: out,
    G,
    report: {
      shared_frames: shared.length,
      disagreement_px: { median: r2(med), max: r2(Math.max(...dis.map((d) => d.px))), worst },
      frames: {
        base: [...source.values()].filter((v) => v === "base").length,
        add_only: [...source.values()].filter((v) => v === "add").length,
        neither: [...source.values()].filter((v) => v === "none").length,
        blended,
      },
      seams: [...new Set(seams)].sort((a, b) => a - b).map((k) => r4(k / fps)),
      carried: { ratio_add: r2(ratioAdd), carried_px: r2(ratioAdd * med), ratio_swapped: r2(ratioSwap), swapped_px: r2(ratioSwap * med) },
    },
  };
}

async function trackJoin(ctx: ToolContext, args: AeTrackJoinArgs): Promise<Record<string, unknown>> {
  const opId = ctx.bridge.newOpId();
  const base = await resolveTrackSource(ctx, opId, args.comp_id, args.base);
  const add = await resolveTrackSource(ctx, `${opId}_add`, args.comp_id, args.add);
  if (base.comp_size[0] !== add.comp_size[0] || base.comp_size[1] !== add.comp_size[1]) {
    throw new PlanarError("refused", `The tracks were made in comps of different sizes (${base.comp_size.join("x")} and ${add.comp_size.join("x")}): their px do not match.`);
  }
  if (Math.abs((base.fps || 25) - (add.fps || 25)) > 1e-3) throw new PlanarError("refused", `The tracks run at different frame rates (${base.fps} and ${add.fps}).`);
  const limitPx = (args.max_disagreement_px * base.comp_size[1]) / 1080;
  const { frames, report } = joinTracks(base, add, { limitPx, blendFrames: args.blend_frames });
  const joined: PlanarTrack = {
    version: 1,
    track_id: newTrackId(),
    comp_id: base.comp_id,
    comp_size: base.comp_size,
    fps: base.fps,
    ref_time: base.ref_time,
    model: "perspective",
    ref_points: base.ref_points,
    frames,
    source: `join of ${base.track_id} (base) and ${add.track_id}`,
    created: new Date().toISOString(),
  };
  // The reference frame keeps an identity motion, as every stored track has.
  const fps = base.fps > 0 ? base.fps : 25;
  const refK = Math.round(base.ref_time * fps);
  const refF = joined.frames.find((f) => Math.round(f.time * fps) === refK);
  if (refF && refF.ok) refF.H = identityH();
  saveTrack(joined);
  const quad = joinQuad(base);
  const samples = joined.frames
    .filter((f) => f.ok && f.H)
    .map((f) => ({ frame: Math.round(f.time * fps), points: quad.map((c) => applyH(f.H!, c)) }))
    .filter((s) => s.points.every((p) => p !== null)) as Array<{ frame: number; points: Vec2[] }>;
  const pc = checkPaths(samples, {});
  const seamFrames = new Set(report.seams.map((t) => Math.round(t * fps)));
  const nearSeam = pc ? pc.flags.filter((f) => [...seamFrames].some((s) => Math.abs(f.frame - s) <= 2)) : [];
  const notes: string[] = [];
  const c = report.carried;
  if (c.carried_px > 1.5 * Math.max(0.3, c.swapped_px) && c.ratio_add > 1.5) {
    notes.push(
      `The frames taken from the add show the surface up to ${c.ratio_add} times larger than the frames both tracks solved, so the relation's error there (median ${report.disagreement_px.median} px) grows to about ${c.carried_px} px. Joined the other way round (base: ${add.track_id}, add: ${base.track_id}), it would be about ${c.swapped_px} px: make the track whose reference shows the surface largest the base. ae_screen_replace takes the corners at any ref_time of the joined track.`
    );
  }
  if (report.frames.neither > 0) notes.push(`${report.frames.neither} frame(s) in the range neither track solved: they stay not ok, and AE interpolates across them when the track is written.`);
  if (nearSeam.length) notes.push(`The path check flags ${nearSeam.length} frame(s) next to a seam (${nearSeam.map((f) => `${r2(f.frame / fps)} s: ${r2(f.px)} px`).join(", ")}): look at them on the written insert.`);
  return {
    ok: true,
    track_id: joined.track_id,
    base: base.track_id,
    add: add.track_id,
    ref_time: base.ref_time,
    frames: joined.frames.length,
    frames_ok: joined.frames.filter((f) => f.ok).length,
    first_time: joined.frames.length ? joined.frames[0].time : null,
    last_time: joined.frames.length ? joined.frames[joined.frames.length - 1].time : null,
    join: report,
    ...(pc
      ? { path_check: { frames_checked: pc.frames_checked, frames_flagged: pc.flags.length, flags: pc.flags.slice(0, 12).map((f) => ({ time: r4(f.frame / fps), kind: f.kind, px: r2(f.px), limit_px: r2(f.limit_px) })) } }
      : {}),
    notes,
    next: "Use the track_id like any other: ae_screen_replace / ae_track_apply with the base's corners at its ref_time.",
  };
}

export const trackJoinTools: ToolDefinition<any>[] = [
  {
    name: "ae_track_join",
    description:
      "Join two planar tracks of the same surface made from different reference frames into one track in the first one's reference: for a shot where the surface's size changes too much for one reference (a close-up that pulls back to a wide shot), track each end with a reference frame of its own (ae_track_multi), then join (the keyframe or reference-frame approach of Nuke, Mocha and Silhouette). " +
      "On the frames both solved it measures how the two references relate (a robust median over a grid on the base's quad) and how far the two tracks put the base's corners apart, in each frame's px; over max_disagreement_px (median) the join is refused. Where only `add` solved, its motion is carried into the base's reference; the base is kept where it solved, blended over the shared frames next to a seam so the hand-over does not jump. " +
      "Make the track whose reference shows the surface LARGEST the base: the relation's error is carried into the add's frames scaled by how much larger the surface shows there than on the shared frames (`join.carried`; a note says when swapping would be better). On HCW's Painting board, joined with the wide shot as base the close-up was 2.3 px off its markers; with the close-up as base, 0.4 px there and 0.6 px in the wide shot. " +
      "Saves a new track (the base and the add are left as they are) and returns its track_id, the disagreement, the seams and the path check of the joined corners. READ-ONLY for the project: nothing in After Effects is touched.",
    schema: AeTrackJoinSchema,
    handler: async (args: AeTrackJoinArgs, ctx: ToolContext) => {
      try {
        return await trackJoin(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return failure(err);
        throw err;
      }
    },
  },
];
