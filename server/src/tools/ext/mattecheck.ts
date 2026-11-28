/**
 * server/src/tools/ext/mattecheck.ts
 *
 * ae_matte_check: is a matte clean? From the alpha of a rendered layer (or the comp's own alpha):
 * holes in the subject, garbage outside it (specks and a faint veil), how wide the soft edge is, and
 * whether the edge chatters (pixels that go up and down from one frame to the next, which smooth
 * motion does not do). A key, a roto, a garbage matte or a track matte all end up as alpha, so one
 * check serves them all. Read-only for the user's work: with `layer`, the layer is rendered alone in
 * a temporary copy of the comp that is removed in the same call.
 */

import * as fs from "node:fs";
import { z } from "zod";
import { buildJsxCall } from "../../jsx.js";
import { defaultFramesDir } from "../render.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { withIsolatedPlate } from "./planar.js";
import { queued } from "./track.js";

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const SOLID = 0.95;
const CLEAR = 0.05;

export interface MatteFrame {
  /** Pixels of the subject (alpha at least 0.5, the largest piece). */
  subject_px: number;
  /** Enclosed see-through pieces inside the subject: count and pixels, largest first (up to 5 with their centre). */
  holes: { count: number; px: number; largest: Array<{ px: number; at: [number, number] }> };
  /** Share of the subject's core (more than 3 px inside its edge) that is not solid (alpha under 0.95). */
  core_not_solid: number;
  /** Separate solid pieces outside the subject. */
  garbage: { count: number; px: number; largest: Array<{ px: number; at: [number, number] }> };
  /** Faint alpha (0.02-0.5) more than 8 px from the subject: a veil left by the key. */
  veil_px: number;
  /** Mean width of the soft edge in px: semi-transparent pixels next to the edge over the edge's length. */
  edge_width_px: number;
  edge_length_px: number;
}

/** Connected pieces (4-neighbour) of `on`, each with its pixels, bounding box test for the border, and centre. */
function pieces(on: Uint8Array, w: number, h: number, labelsOut?: Int32Array): Array<{ px: number; touchesBorder: boolean; cx: number; cy: number; label: number }> {
  const label = labelsOut ?? new Int32Array(w * h);
  label.fill(-1);
  const out: Array<{ px: number; touchesBorder: boolean; cx: number; cy: number; label: number }> = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!on[s] || label[s] !== -1) continue;
    const id = out.length;
    let px = 0;
    let sx = 0;
    let sy = 0;
    let border = false;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % w;
      const y = (k - x) / w;
      px++;
      sx += x;
      sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const n of nb) {
        if (n >= 0 && on[n] && label[n] === -1) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
    out.push({ px, touchesBorder: border, cx: sx / px, cy: sy / px, label: id });
  }
  return out;
}

/** Distance (4-neighbour steps, capped) from each pixel to the nearest pixel where `inside` changes. */
function edgeDistance(inside: Uint8Array, w: number, h: number, cap: number): Uint8Array {
  const d = new Uint8Array(w * h).fill(cap);
  let frontier: number[] = [];
  for (let k = 0; k < w * h; k++) {
    const x = k % w;
    const v = inside[k];
    if ((x > 0 && inside[k - 1] !== v) || (x < w - 1 && inside[k + 1] !== v) || (k >= w && inside[k - w] !== v) || (k < w * (h - 1) && inside[k + w] !== v)) {
      d[k] = 0;
      frontier.push(k);
    }
  }
  for (let step = 1; step < cap && frontier.length; step++) {
    const next: number[] = [];
    for (const k of frontier) {
      const x = k % w;
      for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k >= w ? k - w : -1, k < w * (h - 1) ? k + w : -1]) {
        if (n >= 0 && d[n] > step) {
          d[n] = step;
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return d;
}

/** One frame's alpha (0..1, row-major) judged. */
export function analyseMatte(alpha: Float32Array, w: number, h: number): MatteFrame {
  const n = w * h;
  const half = new Uint8Array(n);
  for (let k = 0; k < n; k++) half[k] = alpha[k] >= 0.5 ? 1 : 0;
  const labels = new Int32Array(n);
  const solidPieces = pieces(half, w, h, labels).sort((a, b) => b.px - a.px);
  const subject = solidPieces[0];
  const empty: MatteFrame = { subject_px: 0, holes: { count: 0, px: 0, largest: [] }, core_not_solid: 0, garbage: { count: 0, px: 0, largest: [] }, veil_px: 0, edge_width_px: 0, edge_length_px: 0 };
  if (!subject) return empty;
  const isSubject = new Uint8Array(n);
  for (let k = 0; k < n; k++) isSubject[k] = labels[k] === subject.label ? 1 : 0;
  const clearish = new Uint8Array(n);
  for (let k = 0; k < n; k++) clearish[k] = isSubject[k] ? 0 : 1;
  const outside = pieces(clearish, w, h);
  const holeList = outside.filter((p) => !p.touchesBorder);
  // Garbage: solid pieces other than the subject, outside every hole (a solid island inside a hole is the subject's business).
  const garbageList = solidPieces.slice(1);
  // Edge: the subject's boundary, and the soft pixels near it.
  const dist = edgeDistance(isSubject, w, h, 12);
  let edgeLen = 0;
  let soft = 0;
  let core = 0;
  let coreSoft = 0;
  let veil = 0;
  for (let k = 0; k < n; k++) {
    const a = alpha[k];
    if (isSubject[k] && dist[k] === 0) edgeLen++;
    if (a > CLEAR && a < SOLID && dist[k] <= 6) soft++;
    if (isSubject[k] && dist[k] > 3) {
      core++;
      if (a < SOLID) coreSoft++;
    }
    if (!isSubject[k] && a > 0.02 && a < 0.5 && dist[k] > 8) veil++;
  }
  const top = (list: typeof outside) =>
    list
      .slice()
      .sort((a, b) => b.px - a.px)
      .slice(0, 5)
      .map((p) => ({ px: p.px, at: [Math.round(p.cx), Math.round(p.cy)] as [number, number] }));
  return {
    subject_px: subject.px,
    holes: { count: holeList.length, px: holeList.reduce((s, p) => s + p.px, 0), largest: top(holeList) },
    core_not_solid: core ? r3(coreSoft / core) : 0,
    garbage: { count: garbageList.length, px: garbageList.reduce((s, p) => s + p.px, 0), largest: top(garbageList) },
    veil_px: veil,
    edge_width_px: edgeLen ? r3(soft / edgeLen) : 0,
    edge_length_px: edgeLen,
  };
}

/**
 * Edge chatter over three consecutive frames: the share of soft or edge pixels of the middle frame
 * whose alpha goes up then down (or down then up) by more than `step` on both sides. Smooth motion
 * moves alpha one way; chatter flips it.
 */
export function edgeChatter(a: Float32Array, b: Float32Array, c: Float32Array, step = 0.15): number {
  let edge = 0;
  let flips = 0;
  for (let k = 0; k < b.length; k++) {
    const lo = Math.min(a[k], b[k], c[k]);
    const hi = Math.max(a[k], b[k], c[k]);
    if (hi < CLEAR || lo > SOLID) continue;
    edge++;
    const d1 = b[k] - a[k];
    const d2 = b[k] - c[k];
    if ((d1 > step && d2 > step) || (d1 < -step && d2 < -step)) flips++;
  }
  return edge ? flips / edge : 0;
}

export const AeMatteCheckSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.optional().describe("The layer whose alpha is the matte (a keyed plate, a roto, a precomp with a track matte). It is rendered alone in a temporary copy of the comp (removed in the same call; needs `expect`). Default: the comp's own alpha (e.g. a keyed-subject precomp)."),
  with_layers: z.array(LayerSelectorSchema).max(20).optional().describe("Layers to keep on with `layer` in the copy: its track matte layer, a garbage matte, a holdout."),
  start: z.number().min(0).optional().describe("First time, seconds. Default the work area start."),
  end: z.number().min(0).optional().describe("Last time, seconds. Default the work area end."),
  samples: z.number().int().min(1).max(10).default(4).describe("Times checked, spread over the range; each renders three consecutive frames (for chatter). Default 4."),
  min_hole_px: z.number().int().min(1).max(100000).default(4).describe("Holes and garbage pieces smaller than this are ignored (noise). Default 4 px."),
  expect: ExpectSchema.optional().describe("Needed with `layer` (the temporary copy is a write)."),
});
type Args = z.infer<typeof AeMatteCheckSchema>;

function alphaOf(img: { width: number; height: number; data: Uint8Array | Buffer }): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let k = 0; k < out.length; k++) out[k] = img.data[k * 4 + 3] / 255;
  return out;
}

export const matteCheckTools: ToolDefinition<any>[] = [
  {
    name: "ae_matte_check",
    description:
      "Checks a matte (any alpha: a key, a roto, a garbage or track matte) on rendered frames: holes inside the subject (enclosed see-through pieces, with where the largest are), how much of the subject's core is not solid, garbage outside it (separate solid specks, and a faint veil more than 8 px away), " +
      "how wide the soft edge is (px), and edge chatter (the share of edge pixels whose alpha flips up and down over three consecutive frames: smooth motion never does that). " +
      "Give `layer` to check one layer's alpha (rendered alone in a temporary copy of the comp, removed in the same call; keep its track matte with `with_layers`; needs `expect`), or leave it out to check the comp's own alpha (a keyed-subject precomp). " +
      "Some holes are real (the gap between an arm and a body): the result says where they are, so look before filling them. Pairs with ae_key_greenscreen, which reports holes and spill for its own key. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeMatteCheckSchema,
    handler: async (args: Args, ctx: ToolContext) => {
      if (args.layer && !args.expect) return { ok: false, error: "bad_args", message: "`layer` renders a temporary copy of the comp, a write: give `expect` (project_path from ae_status)." };
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const toolName = "ae_matte_check";
      const label = `${toolName}(${args.comp_id})`;
      return queued(ctx, label, opId, async () => {
        const comp = (await ctx.bridge.evalRaw<{ width: number | string; height: number | string; fps: number | string; workAreaStart: number | string; workAreaDuration: number | string; duration: number | string; layers?: Array<{ index: number; id: number; name: string }> }>({ id: `${opId}_comp`, script: buildJsxCall("getComp", { comp_id: args.comp_id }), label: `${label} getComp`, mutates: false, toolName })).result;
        const fps = Number(comp.fps) > 0 ? Number(comp.fps) : 25;
        const fd = 1 / fps;
        const start = args.start ?? Number(comp.workAreaStart);
        const end = Math.max(start, (args.end ?? Number(comp.workAreaStart) + Number(comp.workAreaDuration) - fd) - 2 * fd);
        const times: number[] = [];
        for (let i = 0; i < args.samples; i++) times.push(args.samples === 1 ? start : start + ((end - start) * i) / (args.samples - 1));
        let show: Array<{ index: number; id: number }> | null = null;
        let checkpoint: unknown = null;
        if (args.layer) {
          const planar = (await ctx.bridge.evalRaw<{ layers: Array<{ index: number; id: number; name: string }> }>({ id: `${opId}_layers`, script: buildJsxCall("planarComp", { comp_id: args.comp_id, layers: [args.layer, ...(args.with_layers ?? [])] }), label: `${label} layers`, mutates: false, toolName })).result;
          const pick = (sel: { id?: number; index?: number; name?: string }) => planar.layers.find((l) => (sel.id !== undefined ? l.id === sel.id : sel.index !== undefined ? l.index === sel.index : l.name === sel.name));
          const wanted = [args.layer, ...(args.with_layers ?? [])].map(pick);
          if (wanted.some((l) => !l)) return { ok: false, error: "not_found", message: "A layer in `layer` or `with_layers` was not found." };
          show = wanted.map((l) => ({ index: l!.index, id: l!.id }));
          const guard = await verifyTargetGuard(ctx, { project_path: args.expect!.project_path, comp_id: args.expect!.comp_id ?? args.comp_id }, opId);
          checkpoint = await autoCheckpoint(ctx, guard, toolName);
        }
        const run = await withIsolatedPlate(ctx, opId, { compId: args.comp_id, showLayers: show, expect: args.expect ?? { project_path: "" }, toolName }, async (renderId) => {
          const rows: Array<{ time: number; frame: MatteFrame; chatter: number }> = [];
          let fi = 0;
          for (const t of times) {
            const triple: Float32Array[] = [];
            let w = 0;
            let h = 0;
            for (const dt of [0, fd, 2 * fd]) {
              const snap = await captureCompFrame({ ctx, opId, compId: renderId, time: t + dt, frameIndex: fi++, framesDir, toolName });
              const img = decodePngFile(snap.path);
              fs.rmSync(snap.path, { force: true });
              w = img.width;
              h = img.height;
              triple.push(alphaOf(img));
            }
            rows.push({ time: t + fd, frame: analyseMatte(triple[1], w, h), chatter: edgeChatter(triple[0], triple[1], triple[2]) });
          }
          return rows;
        });
        const rows = run.value;
        const minPx = args.min_hole_px;
        const keep = (list: Array<{ px: number; at: [number, number] }>) => list.filter((p) => p.px >= minPx);
        const frames = rows.map((r) => ({
          time: r3(r.time),
          subject_px: r.frame.subject_px,
          holes: keep(r.frame.holes.largest),
          holes_total: r.frame.holes.count,
          core_not_solid: r.frame.core_not_solid,
          garbage: keep(r.frame.garbage.largest),
          garbage_total: r.frame.garbage.count,
          veil_px: r.frame.veil_px,
          edge_width_px: r.frame.edge_width_px,
          edge_chatter: r3(r.chatter),
        }));
        const maxOf = (f: (x: (typeof frames)[number]) => number) => Math.max(...frames.map(f));
        const findings: string[] = [];
        if (frames.every((f) => f.subject_px === 0)) findings.push("No subject: the alpha is empty (is the matte on this layer, or does it need its track matte in with_layers?).");
        if (maxOf((f) => f.holes.length) > 0) findings.push(`Holes inside the subject on ${frames.filter((f) => f.holes.length).length} of ${frames.length} frames (largest ${maxOf((f) => f.holes[0]?.px ?? 0)} px): fill them (choke and grow, Key Cleaner, a core matte) unless they are real gaps.`);
        if (maxOf((f) => f.core_not_solid) > 0.01) findings.push(`Up to ${Math.round(maxOf((f) => f.core_not_solid) * 1000) / 10}% of the subject's core is not solid: the key is see-through inside (clip white, or a core matte).`);
        if (maxOf((f) => f.garbage.length) > 0) findings.push(`Garbage outside the subject (up to ${maxOf((f) => f.garbage.length)} pieces): a garbage matte (ae_garbage_matte) or clip black.`);
        if (maxOf((f) => f.veil_px) > 50) findings.push(`A faint veil away from the subject (up to ${maxOf((f) => f.veil_px)} px of alpha 0.02-0.5): clip black.`);
        if (maxOf((f) => f.edge_chatter) > 0.05) findings.push(`The edge chatters (up to ${Math.round(maxOf((f) => f.edge_chatter) * 100)}% of edge pixels flip between frames): soften or blur the matte over time, or stabilise the key settings.`);
        return {
          ok: true,
          verdict: findings.length ? "needs work" : "clean",
          frames,
          edge_width_px: { min: Math.min(...frames.map((f) => f.edge_width_px)), max: maxOf((f) => f.edge_width_px) },
          findings,
          ...(run.temp ? { temp_comp: { copy_removed: run.temp.removed, ...(run.temp.error ? { error: run.temp.error } : {}) }, checkpoint } : {}),
          notes: ["Measured on the 8-bit alpha AE renders. Holes are see-through pieces the subject surrounds; garbage is separate solid pieces; both ignore pieces under min_hole_px."],
        };
      });
    },
  },
];
