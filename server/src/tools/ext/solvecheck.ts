/**
 * server/src/tools/ext/solvecheck.ts
 *
 * ae_camera_solve_check: how well a 3D camera solve (AE's 3D Camera Tracker, or one brought in from
 * elsewhere) keeps its points on the picture. Starting the Camera Tracker's analysis and creating its
 * camera are left to the user (AE does not script them reliably); this checks the result.
 *
 * Each chosen 3D layer (the nulls the Camera Tracker made at its track points) is projected through
 * the camera at every sampled frame with the maths checked against AE's own toComp
 * (annotate.ts, docs/CALIBRATION.md). The picture around the point on its first frame is the
 * pattern; on every later frame it is warped by how the camera says a small patch facing it there
 * has scaled and turned (the projection's local affine) and looked for around the projected spot.
 * Where it is found against where the camera puts it is the solve's error at that point: how far an
 * element parented to that null would slide on the plate. Without the warp a 20% dolly read 1-3 px
 * on a perfect solve; chaining the pattern frame to frame instead added up the matching noise.
 * Measured from the first frame on, so a point that sits a little off its feature from the start
 * but stays with it reads 0.
 *
 * Read-only: renders frames, changes nothing.
 */

import * as fs from "node:fs";
import { z } from "zod";
import { buildJsxCall } from "../../jsx.js";
import { checkCancelled } from "../../call-context.js";
import { defaultFramesDir } from "../render.js";
import { AGENT_SAFETY_GUIDANCE, LayerSelectorSchema, type LayerSelector, type ToolContext, type ToolDefinition } from "../common.js";
import { cameraModel, chainMatrix, layerMap, transformPoint, type CameraModel, type Vec3 } from "./annotate.js";
import type { SceneLayer, SceneRead } from "./camera.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { makeWarpedTemplate, PointTracker, queued, toGray, trackTimes, type TrackOptions } from "./track.js";

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const MAX_POINTS = 40;

export const AeCameraSolveCheckSchema = z.object({
  comp_id: z.number().int(),
  points: z
    .array(LayerSelectorSchema)
    .min(1)
    .max(MAX_POINTS)
    .optional()
    .describe("The 3D layers that mark tracked features: the nulls the 3D Camera Tracker made ('Create Null and Camera' on selected track points). Default: every 3D null in the comp (up to 40)."),
  camera: LayerSelectorSchema.optional().describe("The solved camera. Default: the front-most enabled camera at each frame."),
  start: z.number().min(0).optional().describe("First time, seconds. Default the work area start."),
  end: z.number().min(0).optional().describe("Last time, seconds. Default the work area end."),
  max_frames: z.number().int().min(3).max(200).default(30).describe("Frames sampled, spread evenly over the range (each is a render). Default 30."),
  pattern_size: z.number().int().min(9).max(101).default(31).describe("Side of the pattern taken around each point, comp pixels. Default 31."),
  search_radius: z.number().int().min(2).max(100).default(24).describe("How far around the projected position the pattern is looked for, comp pixels. Default 24: a solve worse than that reads as lost."),
  good_px: z.number().min(0.05).max(20).default(0.5).describe("A point whose 95th-percentile error is under this sticks. Default 0.5."),
  poor_px: z.number().min(0.1).max(50).default(1.5).describe("Over this a point visibly slides. Default 1.5."),
});
type Args = z.infer<typeof AeCameraSolveCheckSchema>;

interface CompInfo {
  width: number | string;
  height: number | string;
  fps: number | string;
  workAreaStart: number | string;
  workAreaDuration: number | string;
}

function pick(layers: SceneLayer[], sel: LayerSelector): SceneLayer | undefined {
  if (sel.id !== undefined) return layers.find((l) => l.id === sel.id);
  if (sel.index !== undefined) return layers.find((l) => l.index === sel.index);
  const named = layers.filter((l) => l.name === sel.name);
  return named.length === 1 ? named[0] : undefined;
}

/** A world point on screen through a camera model, comp px; null behind the camera. */
export function projectWorld(model: CameraModel, comp: { width: number; height: number }, w: Vec3): [number, number] | null {
  const c = transformPoint(model.view, w);
  if (c[2] <= 1e-6) return null;
  return [comp.width / 2 + (c[0] / c[2]) * model.zoom, comp.height / 2 + (c[1] / c[2]) * model.zoom];
}

/** Each point's world position and where it lands at one read; the camera model for warping. */
export function projectPoints(
  read: SceneRead,
  pointIds: number[],
  cameraId: number | null
): { model: CameraModel; world: Array<Vec3 | null>; screen: Array<[number, number] | null>; camera: string | null; note?: string } {
  const byId = layerMap(read.layers);
  const model = cameraModel({ ...read, active_camera_id: cameraId ?? read.active_camera_id }, byId);
  const world = pointIds.map((id) => {
    const l = byId.get(id);
    if (!l || !l.transform) return null;
    const chain = chainMatrix({ ...l, auto_orient_active: false }, byId);
    if (!chain.matrix) return null;
    const a = l.transform.anchor;
    return transformPoint(chain.matrix, [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0] as Vec3);
  });
  const screen = world.map((w) => (w ? projectWorld(model, read.comp, w) : null));
  return { model, world, screen, camera: model.source === "layer" ? (model.name ?? null) : null, ...(model.note ? { note: model.note } : {}) };
}

/**
 * How a small patch at world point w, facing the camera at the reference read, maps from its
 * reference screen position to the current one: a 2x2 [a, b, c, d] (row-major), or null.
 * The patch's two edges are the reference camera's x and y axes in world space.
 */
export function localAffine(ref: CameraModel, cur: CameraModel, comp: { width: number; height: number }, w: Vec3): number[] | null {
  // The camera's axes in world space are the rows of the view matrix's rotation part.
  const v = ref.view;
  const ax: Vec3 = [v[0], v[1], v[2]];
  const ay: Vec3 = [v[4], v[5], v[6]];
  const eps = 4;
  const at = (m: CameraModel, d: Vec3) => projectWorld(m, comp, [w[0] + d[0] * eps, w[1] + d[1] * eps, w[2] + d[2] * eps]);
  const r0 = at(ref, [0, 0, 0]);
  const rx = at(ref, ax);
  const ry = at(ref, ay);
  const c0 = at(cur, [0, 0, 0]);
  const cx = at(cur, ax);
  const cy = at(cur, ay);
  if (!r0 || !rx || !ry || !c0 || !cx || !cy) return null;
  // A_ref = [rx - r0, ry - r0] (columns), A_cur likewise; J = A_cur . A_ref^-1.
  const a = rx[0] - r0[0], c = rx[1] - r0[1], b = ry[0] - r0[0], d = ry[1] - r0[1];
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-9)) return null;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const p = cx[0] - c0[0], r = cx[1] - c0[1], q = cy[0] - c0[0], s = cy[1] - c0[1];
  return [p * ia + q * ic, p * ib + q * id, r * ia + s * ic, r * ib + s * id];
}

const pct = (xs: number[], p: number) => {
  const v = xs.slice().sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0;
};

export const solveCheckTools: ToolDefinition<any>[] = [
  {
    name: "ae_camera_solve_check",
    description:
      "Checks a 3D camera solve (AE's 3D Camera Tracker, or a camera brought in from Mocha, SynthEyes, Blender) against the picture: does each solved point stay on its feature? " +
      "Give the 3D nulls that mark tracked features (the Camera Tracker's 'Create Null and Camera' on selected track points; default every 3D null in the comp). Each is projected through the camera at every sampled frame, " +
      "with 3D maths that matches AE's own toComp; the picture around it on the first frame is searched for on the others around the projected spot, and the distance is the solve's error there: how far an element parented to that null would slide on the plate. " +
      "Returns per point the mean, 95th-percentile and largest error in comp pixels, whether it was lost, how the error grows over the shot (drift), the worst frames, and a verdict (sticks, slides a little, slides). " +
      "Start the Camera Tracker's analysis and create its camera by hand (AE does not script them reliably), then check here; a high error on most points means a bad solve (set the lens or film size, track more points, or solve again), on a few points that those points are on something moving or a reflection. " +
      "Points must sit on visible texture (a flat area cannot be followed; it is reported). Read-only: renders frames (one per sampled frame), changes nothing. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeCameraSolveCheckSchema,
    handler: async (args: Args, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const label = `ae_camera_solve_check(${args.comp_id})`;
      return queued(ctx, label, opId, async () => {
        const comp = (
          await ctx.bridge.evalRaw<CompInfo>({ id: `${opId}_comp`, script: buildJsxCall("getComp", { comp_id: args.comp_id }), label: `${label} getComp`, mutates: false, toolName: "ae_camera_solve_check" })
        ).result;
        const fps = Number(comp.fps) > 0 ? Number(comp.fps) : 25;
        const start = args.start ?? Number(comp.workAreaStart);
        const end = args.end ?? Number(comp.workAreaStart) + Number(comp.workAreaDuration) - 1 / fps;
        const all = trackTimes(start, end, fps, 100000);
        const stepN = Math.max(1, Math.ceil(all.length / args.max_frames));
        const times = all.filter((_, i) => i % stepN === 0).slice(0, args.max_frames);
        if (times.length < 2) return { ok: false, error: "bad_args", message: "The range holds fewer than two frames." };

        const readAt = async (t: number, i: number) =>
          (await ctx.bridge.evalRaw<SceneRead>({ id: `${opId}_read${i}`, script: buildJsxCall("cameraSceneRead", { comp_id: args.comp_id, time: t }), label: `${label} read @ ${t}s`, mutates: false, toolName: "ae_camera_solve_check" })).result;

        const first = await readAt(times[0], 0);
        // The points and the camera, picked once.
        let pointLayers: SceneLayer[];
        if (args.points) {
          const missing: string[] = [];
          pointLayers = [];
          for (const sel of args.points) {
            const l = pick(first.layers, sel);
            if (!l) missing.push(JSON.stringify(sel));
            else if (!l.three_d) return { ok: false, error: "bad_args", message: `"${l.name}" is not a 3D layer; a solve check needs the 3D nulls of the solve.` };
            else pointLayers.push(l);
          }
          if (missing.length) return { ok: false, error: "not_found", message: `No single layer matches ${missing.join(", ")} in the first 500 layers.` };
        } else {
          pointLayers = first.layers.filter((l) => l.three_d && l.kind === "null").slice(0, MAX_POINTS);
          if (!pointLayers.length) return { ok: false, error: "not_found", message: "The comp has no 3D nulls. In the 3D Camera Tracker, select track points and use 'Create Null and Camera', then check again (or pass `points`)." };
        }
        let cameraId: number | null = null;
        if (args.camera) {
          const cam = pick(first.layers.filter((l) => l.kind === "camera"), args.camera);
          if (!cam) return { ok: false, error: "not_found", message: "No single camera layer matches `camera`." };
          cameraId = cam.id;
        } else if (first.active_camera_id === null) {
          return { ok: false, error: "not_found", message: "The comp has no camera at the first frame: there is no solve to check." };
        }

        const ids = pointLayers.map((l) => l.id);
        const width = Number(comp.width);
        const opts: TrackOptions = { patchSize: args.pattern_size | 1, searchRadius: args.search_radius, minConfidence: 0.6, adaptBelow: 0.8 };
        // Per point, from its first measured frame: the tracker (first pattern), that frame's image, position and camera.
        const trackers: Array<PointTracker | null> = ids.map(() => null);
        const refOf: Array<{ gray: ReturnType<typeof toGray>; x: number; y: number; model: CameraModel; world: Vec3; patch: number } | null> = ids.map(() => null);
        const series: Array<Array<[number, number]>> = ids.map(() => []);
        const found: Array<[number, number] | null> = ids.map(() => null);
        const stepOpts = (scale: number): TrackOptions => ({ ...opts, patchSize: Math.max(9, Math.round(opts.patchSize * scale) | 1), searchRadius: Math.max(2, Math.round(opts.searchRadius * scale)) });
        const flat: string[] = [];
        const errs: number[][] = ids.map(() => []);
        const lostAt: Array<number | null> = ids.map(() => null);
        const offScreen: number[] = ids.map(() => 0);
        // A point measured until it reached the frame's edge: its pattern would be cut there, so it ends.
        const ended: boolean[] = ids.map(() => false);
        // Half a pattern plus a little: closer to the edge than this the pattern is cut off.
        const margin = args.pattern_size / 2 + 2;
        const perFrame: Array<{ time: number; mean: number | null }> = [];
        let cameraName: string | null = null;
        const notes: string[] = [];

        for (let i = 0; i < times.length; i++) {
          checkCancelled(`frame ${i + 1} of ${times.length}`);
          const read = i === 0 ? first : await readAt(times[i], i);
          const proj = projectPoints(read, ids, cameraId);
          if (proj.note && !notes.includes(proj.note)) notes.push(proj.note);
          cameraName = cameraName ?? proj.camera;
          const snap = await captureCompFrame({ ctx, opId, compId: args.comp_id, time: times[i], frameIndex: i, framesDir, toolName: "ae_camera_solve_check" });
          const png = decodePngFile(snap.path);
          fs.rmSync(snap.path, { force: true });
          const gray = toGray(png);
          const scale = png.width / width;
          const frameErrs: number[] = [];
          ids.forEach((_, k) => {
            const p = proj.screen[k];
            if (!p || p[0] < margin || p[1] < margin || p[0] >= width - margin || p[1] >= Number(comp.height) - margin) {
              offScreen[k]++;
              if (found[k] !== null) ended[k] = true;
              return;
            }
            if (ended[k]) return;
            const ix = p[0] * scale - 0.5;
            const iy = p[1] * scale - 0.5;
            if (lostAt[k] !== null || flat.includes(pointLayers[k].name)) return;
            const w = proj.world[k];
            if (!w) return;
            if (trackers[k] === null) {
              // The first frame the point is on screen: it starts on its projection.
              try {
                const o = stepOpts(scale);
                trackers[k] = new PointTracker(gray, ix, iy, o);
                refOf[k] = { gray, x: ix, y: iy, model: proj.model, world: w, patch: o.patchSize };
                found[k] = [ix, iy];
                series[k].push([r3(times[i]), 0]);
              } catch {
                flat.push(pointLayers[k].name);
              }
              return;
            }
            const ref = refOf[k]!;
            // The first frame's pattern, warped the way the camera turns and scales a patch facing it there.
            const J = localAffine(ref.model, proj.model, read.comp, ref.world);
            const tpl = J ? makeWarpedTemplate(ref.gray, ref.x, ref.y, ref.patch, [J[0], J[1], 0, J[2], J[3], 0]) : null;
            const s = trackers[k]!.step(gray, { x: ix, y: iy }, tpl && tpl.std >= 3 ? tpl : undefined);
            if (!s) {
              lostAt[k] = times[i];
              return;
            }
            found[k] = [s.x, s.y];
            const e = Math.hypot((s.x - ix) / scale, (s.y - iy) / scale);
            errs[k].push(e);
            series[k].push([r3(times[i]), r3(e)]);
            frameErrs.push(e);
          });
          perFrame.push({ time: times[i], mean: frameErrs.length ? frameErrs.reduce((a, b) => a + b, 0) / frameErrs.length : null });
        }

        const points = pointLayers.map((l, k) => {
          const e = errs[k];
          const third = Math.max(1, Math.floor(e.length / 3));
          const early = e.slice(0, third);
          const late = e.slice(-third);
          const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
          const p95 = pct(e, 0.95);
          let verdict: string;
          if (flat.includes(l.name)) verdict = "not measurable (flat picture under it)";
          else if (e.length === 0) verdict = offScreen[k] >= times.length - 1 ? "off screen (or within half a pattern of the edge)" : "not measurable";
          else if (lostAt[k] !== null) verdict = "slides (lost)";
          else if (p95 <= args.good_px) verdict = "sticks";
          else if (p95 <= args.poor_px) verdict = "slides a little";
          else verdict = "slides";
          return {
            id: l.id,
            name: l.name,
            frames_measured: e.length,
            mean_px: e.length ? r3(avg(e)) : null,
            p95_px: e.length ? r3(p95) : null,
            max_px: e.length ? r3(Math.max(...e)) : null,
            drift_px: e.length >= 3 ? r3(avg(late) - avg(early)) : null,
            lost_at: lostAt[k],
            frames_off_screen: offScreen[k],
            ...(ended[k] ? { left_frame: true } : {}),
            series: series[k],
            verdict,
          };
        });
        const measured = points.filter((p) => p.mean_px !== null);
        const allErr = errs.flat();
        const sliding = points.filter((p) => p.verdict.startsWith("slides"));
        let verdict: string;
        if (measured.length === 0) verdict = "not measurable";
        else if (sliding.length === 0) verdict = "the solve sticks";
        else if (sliding.length >= Math.max(2, measured.length * 0.5)) verdict = "the solve slides: most points move against the picture";
        else verdict = "the solve mostly sticks; a few points slide";
        if (sliding.length >= Math.max(2, measured.length * 0.5)) {
          notes.push("Most points slide: the solve itself is off. Set the lens (Camera Tracker > Advanced > Method, or the known focal length and film size), track more and longer points, or solve again; check that these nulls belong to this camera.");
        } else if (sliding.length) {
          notes.push(`Sliding: ${sliding.map((p) => p.name).join(", ")}. If the others stick, those points are on something moving, a reflection, or the wrong depth: parent nothing to them.`);
        }
        if (flat.length) notes.push(`No texture to follow under ${flat.join(", ")}: they are left out.`);
        const worst = perFrame.filter((f) => f.mean !== null).sort((a, b) => (b.mean as number) - (a.mean as number)).slice(0, 3);
        return {
          ok: true,
          read_only: true,
          camera: cameraName ?? (cameraId === null ? "the front-most enabled camera" : null),
          frames: times.length,
          frame_step: stepN,
          range: { start: r3(times[0]), end: r3(times[times.length - 1]) },
          verdict,
          error_px: allErr.length ? { mean: r3(allErr.reduce((a, b) => a + b, 0) / allErr.length), p95: r3(pct(allErr, 0.95)), max: r3(Math.max(...allErr)) } : null,
          points,
          series_format: "points[].series: [time_s, error_px] per measured frame",
          worst_frames: worst.map((f) => ({ time: r3(f.time), mean_px: r3(f.mean as number) })),
          thresholds: { good_px: args.good_px, poor_px: args.poor_px },
          notes,
        };
      });
    },
  },
];
