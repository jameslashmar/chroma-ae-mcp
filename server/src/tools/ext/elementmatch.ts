/**
 * server/src/tools/ext/elementmatch.ts
 *
 * ae_color_match_element: colour-match an element (a CG render, a keyed person, a sign) to the plate
 * it sits in, from pairs of regions the user picks: the element's shadow against a shadow in the
 * plate, its mid tone against a mid tone, its white against a white. Per channel a Levels
 * (Individual Controls) is fitted: black and white from the darkest and brightest pairs, gamma from
 * the middle one. The fit is written as one effect on the element ("Chroma element match"), then a
 * second render measures what is left per pair. The choice of regions is the user's: the tool says
 * what it measured, never which areas should match.
 */

import * as fs from "node:fs";
import { z } from "zod";
import { buildJsxCall } from "../../jsx.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { defaultFramesDir } from "../render.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import { RegionShapeSchema } from "./patchcheck.js";
import { rasterizePolygon, regionToPolygon, type RegionSpec } from "./region-math.js";
import { queued } from "./track.js";
import { runGuardedWrite } from "./write-runner.js";

export const ELEMENT_EFFECT_NAME = "Chroma element match";
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const AeColorMatchElementSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.describe("The element to match (it gets the Levels)."),
  pairs: z
    .array(
      z.object({
        name: z.string().max(40).optional().describe("A label, e.g. 'shadow', 'mid', 'white'."),
        element: RegionShapeSchema.describe("An area of the element, as it shows in the comp."),
        plate: RegionShapeSchema.describe("An area of the plate that should look the same (same material and light, e.g. a shadow next to the element's shadow)."),
      })
    )
    .min(1)
    .max(3)
    .describe("1 pair: a gain per channel. 2: black and white (or offset and gain). 3: black, white and gamma, from the darkest, brightest and middle pairs (by the element's brightness)."),
  time: z.number().min(0).optional().describe("The frame to measure, seconds. Default the comp's current time."),
  dry_run: z.boolean().default(false).describe("Measure and fit; write nothing."),
  replace_existing: z.boolean().default(false).describe(`Replace an earlier "${ELEMENT_EFFECT_NAME}" effect: the measurement is undone through it first, so the new fit starts from the raw element.`),
  expect: ExpectSchema,
});
type Args = z.infer<typeof AeColorMatchElementSchema>;

export interface LevelsChannel {
  in_black: number;
  in_white: number;
  gamma: number;
  out_black: number;
  out_white: number;
}

/** AE Levels on a 0..1 value: clamp to the input range, normalise, gamma (above 1 lifts the mids), map to the output range. */
export function levelsApply(l: LevelsChannel, v: number): number {
  const span = l.in_white - l.in_black;
  const x = span > 1e-6 ? clamp((v - l.in_black) / span, 0, 1) : v >= l.in_white ? 1 : 0;
  return l.out_black + (l.out_white - l.out_black) * Math.pow(x, 1 / l.gamma);
}

/** Levels undone on a 0..1 value (within the ranges it does not clip). */
export function levelsInverse(l: LevelsChannel, v: number): number {
  const span = l.out_white - l.out_black;
  const y = Math.abs(span) > 1e-6 ? clamp((v - l.out_black) / span, 0, 1) : 0;
  return l.in_black + (l.in_white - l.in_black) * Math.pow(y, l.gamma);
}

/**
 * Per channel Levels taking each pair's element value to its plate value (0..1). Pairs sorted by the
 * element's value: the line through the darkest and brightest sets the black and white points (as
 * input or output points, whichever keeps them in 0..1), the middle pair the gamma.
 */
export function fitLevels(pairs: Array<{ element: number; plate: number }>): LevelsChannel {
  const id: LevelsChannel = { in_black: 0, in_white: 1, gamma: 1, out_black: 0, out_white: 1 };
  const ps = pairs.slice().sort((a, b) => a.element - b.element);
  let a: number;
  let b: number;
  if (ps.length === 1) {
    a = ps[0].element > 1e-4 ? ps[0].plate / ps[0].element : 1;
    b = 0;
  } else {
    const lo = ps[0];
    const hi = ps[ps.length - 1];
    if (hi.element - lo.element < 0.02) {
      // Pairs too close in brightness to set a slope: a gain through their mean.
      const e = (lo.element + hi.element) / 2;
      a = e > 1e-4 ? (lo.plate + hi.plate) / 2 / e : 1;
      b = 0;
    } else {
      a = (hi.plate - lo.plate) / (hi.element - lo.element);
      b = lo.plate - a * lo.element;
    }
  }
  if (!(a > 1e-3)) return id; // an inverted or flat mapping is not a Levels; leave the channel alone
  // The line p = a e + b over e in 0..1, kept inside 0..1 on both sides.
  const out_black = clamp(b, 0, 1);
  const out_white = clamp(a + b, 0, 1);
  const lv: LevelsChannel = { in_black: (out_black - b) / a, in_white: (out_white - b) / a, gamma: 1, out_black, out_white };
  if (ps.length < 3) return lv;
  // Three pairs: two Levels families with three free values each, fitted exactly where they can:
  // output side (black, white, gamma with the input untouched) and input side (the same on the input).
  // The better fit wins; when both fit, the one that changes least.
  const fams: Array<{ make: (q: number[]) => LevelsChannel; start: number[] }> = [
    { make: (q) => ({ in_black: 0, in_white: 1, gamma: Math.exp(q[2]), out_black: q[0], out_white: q[1] }), start: [lv.out_black, lv.out_white, 0] },
    { make: (q) => ({ in_black: q[0], in_white: q[1], gamma: Math.exp(q[2]), out_black: 0, out_white: 1 }), start: [lv.in_black, lv.in_white, 0] },
  ];
  const err = (l: LevelsChannel) => ps.reduce((c, p) => c + (levelsApply(l, p.element) - p.plate) ** 2, 0);
  const change = (l: LevelsChannel) => Math.abs(l.in_black) + Math.abs(1 - l.in_white) + Math.abs(Math.log(l.gamma)) + Math.abs(l.out_black) + Math.abs(1 - l.out_white);
  let best: { l: LevelsChannel; e: number } | null = null;
  for (const fam of fams) {
    const cost = (q: number[]) => (q[0] < 0 || q[1] > 1 || q[1] - q[0] < 0.05 || Math.abs(q[2]) > Math.log(5) ? 1e9 : err(fam.make(q)));
    const start = fam.start.map((v, k) => (k < 2 ? clamp(v, 0, 1) : v));
    if (start[1] - start[0] < 0.05) {
      start[0] = 0;
      start[1] = 1;
    }
    const l = fam.make(nelderMead(cost, start, 0.05, 2000));
    const e = err(l);
    if (!best || e < best.e - 1e-9 || (Math.abs(e - best.e) <= 1e-9 && change(l) < change(best.l))) best = { l, e };
  }
  // Neither family beats the straight line through the extremes: keep it.
  return best && best.e <= err(lv) ? best.l : lv;
}

/** A small Nelder-Mead minimiser. */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number, iterations: number): number[] {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.f - b.f);
    if (Math.abs(simplex[n].f - simplex[0].f) < 1e-14 && it > 50) break;
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j] / n;
    const worst = simplex[n];
    const at = (t: number) => centroid.map((c, j) => c + t * (worst.x[j] - c));
    const refl = at(-1);
    const fr = f(refl);
    if (fr < simplex[0].f) {
      const exp = at(-2);
      const fe = f(exp);
      simplex[n] = fe < fr ? { x: exp, f: fe } : { x: refl, f: fr };
    } else if (fr < simplex[n - 1].f) {
      simplex[n] = { x: refl, f: fr };
    } else {
      const con = at(0.5);
      const fc = f(con);
      if (fc < worst.f) simplex[n] = { x: con, f: fc };
      else simplex = simplex.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => simplex[0].x[j] + 0.5 * (v - simplex[0].x[j])), f: 0 })).map((p, i) => (i === 0 ? p : { x: p.x, f: f(p.x) }));
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  return simplex[0].x;
}

function regionMean(img: { width: number; height: number; data: Uint8Array | Buffer }, shape: RegionSpec, compW: number): { rgb: [number, number, number]; pixels: number } {
  const s = img.width / compW;
  const poly = regionToPolygon(shape).map((p) => [p[0] * s, p[1] * s] as [number, number]);
  const mask = rasterizePolygon(img.width, img.height, poly);
  const sum = [0, 0, 0];
  let n = 0;
  for (let k = 0; k < mask.length; k++) {
    if (mask[k] < 0.5) continue;
    const i = k * 4;
    sum[0] += img.data[i];
    sum[1] += img.data[i + 1];
    sum[2] += img.data[i + 2];
    n++;
  }
  return { rgb: n ? [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255] : [0, 0, 0], pixels: n };
}

const CH = ["red", "green", "blue"] as const;

export const elementMatchTools: ToolDefinition<any>[] = [
  {
    name: "ae_color_match_element",
    description:
      "Colour-match an element (CG render, keyed person, sign, insert) to its plate from 1-3 pairs of regions you choose: an area of the element and an area of the plate that should look the same (the element's shadow against a plate shadow, its mid tone, its white). " +
      "Per channel a Levels (Individual Controls) is fitted: 1 pair a gain, 2 black and white, 3 also gamma (from the darkest, brightest and middle pairs). It is written as one effect, \"Chroma element match\", on the element in one undo step, " +
      "then a second render measures what is left per pair (levels of 255). `dry_run` fits and writes nothing. The regions are measured on the comp's render at `time`, so pick areas where the element is opaque and the plate is not covered. " +
      "Light direction, shadows and grain are not matched here (ae_patch_grain matches grain). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeColorMatchElementSchema,
    handler: async (args: Args, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const framesDir = defaultFramesDir();
      fs.mkdirSync(framesDir, { recursive: true });
      const toolName = "ae_color_match_element";
      const label = `${toolName}(${args.comp_id})`;
      const comp = (await ctx.bridge.evalRaw<{ width: number | string; time: number | string }>({ id: `${opId}_comp`, script: buildJsxCall("getComp", { comp_id: args.comp_id }), label: `${label} getComp`, mutates: false, toolName })).result;
      const compW = Number(comp.width);
      const time = args.time ?? Number(comp.time);
      const stateRead = () => ({ host: "patchfitEffectState", args: { comp_id: args.comp_id, layer: args.layer, name: ELEMENT_EFFECT_NAME, times: [time] } });

      const measure = async (tag: string) =>
        queued(ctx, `${label} ${tag}`, opId, async () => {
          const snap = await captureCompFrame({ ctx, opId, compId: args.comp_id, time, frameIndex: tag === "before" ? 0 : 1, framesDir, toolName });
          const img = decodePngFile(snap.path);
          fs.rmSync(snap.path, { force: true });
          return args.pairs.map((p) => ({ element: regionMean(img, p.element as RegionSpec, compW), plate: regionMean(img, p.plate as RegionSpec, compW) }));
        });

      const before = await measure("before");
      const empty = before.flatMap((m, i) => [m.element.pixels === 0 ? `pairs[${i}].element` : null, m.plate.pixels === 0 ? `pairs[${i}].plate` : null]).filter(Boolean);
      if (empty.length) return { ok: false, error: "bad_args", message: `These regions hold no pixels of the frame: ${empty.join(", ")}.` };

      // An earlier match is undone on the measured values, so the new fit starts from the raw element.
      const state = (await ctx.bridge.evalRaw<{ effect: { params: Array<{ name: string; value: number | null }> } | null }>({ id: `${opId}_state`, script: buildJsxCall(stateRead().host, stateRead().args), label: `${label} state`, mutates: false, toolName })).result;
      let old: Record<(typeof CH)[number], LevelsChannel> | null = null;
      if (state.effect) {
        if (!args.replace_existing) return { ok: false, error: "bad_args", message: `The element already has "${ELEMENT_EFFECT_NAME}". Pass replace_existing to fit again from the raw element (the old one is undone on the measurement and replaced).` };
        const v = (n: string) => state.effect!.params.find((p) => p.name === n)?.value ?? null;
        const unit = (v("Red Input White") ?? 1) > 1.5 ? (v("Red Input White") as number) : 1;
        const ch = (label: string): LevelsChannel => ({
          in_black: (v(`${label} Input Black`) ?? 0) / unit,
          in_white: (v(`${label} Input White`) ?? unit) / unit,
          gamma: v(`${label} Gamma`) ?? 1,
          out_black: (v(`${label} Output Black`) ?? 0) / unit,
          out_white: (v(`${label} Output White`) ?? unit) / unit,
        });
        old = { red: ch("Red"), green: ch("Green"), blue: ch("Blue") };
      }
      const raw = before.map((m) => ({ ...m, element: { ...m.element, rgb: m.element.rgb.map((x, c) => (old ? levelsInverse(old[CH[c]], x) : x)) as [number, number, number] } }));

      const fit = Object.fromEntries(CH.map((c, ci) => [c, fitLevels(raw.map((m) => ({ element: m.element.rgb[ci], plate: m.plate.rgb[ci] })))])) as Record<(typeof CH)[number], LevelsChannel>;
      const pairsOut = raw.map((m, i) => ({
        name: args.pairs[i].name ?? `pair ${i + 1}`,
        element_rgb: m.element.rgb.map((x) => r2(x * 255)),
        plate_rgb: m.plate.rgb.map((x) => r2(x * 255)),
        predicted_left_rgb: CH.map((c, ci) => r2((levelsApply(fit[c], m.element.rgb[ci]) - m.plate.rgb[ci]) * 255)),
      }));
      const levels = Object.fromEntries(CH.map((c) => [c, { in_black: r4(fit[c].in_black), in_white: r4(fit[c].in_white), gamma: r4(fit[c].gamma), out_black: r4(fit[c].out_black), out_white: r4(fit[c].out_white) }]));
      const head = { ok: true, op_id: opId, time, levels, levels_unit: "0..1 (AE shows them in the comp's bit depth)", pairs: pairsOut };
      if (args.dry_run) return { ...head, applied: false, notes: ["dry_run: nothing was written."] };

      const series = Object.fromEntries(CH.map((c) => [c, { in_black: [fit[c].in_black], in_white: [fit[c].in_white], gamma: [fit[c].gamma], out_black: [fit[c].out_black], out_white: [fit[c].out_white] }]));
      const wrote = await runGuardedWrite(ctx, {
        toolName,
        label: `${label} write`,
        expect: args.expect,
        compId: args.comp_id,
        read: () => stateRead(),
        write: {
          host: "patchfitColorApply",
          args: { comp_id: args.comp_id, layer: args.layer, mode: "levels", with_gamma: true, effect_name: ELEMENT_EFFECT_NAME, times: [time], series, replace_existing: args.replace_existing, label: "Chroma AE MCP: element colour match" },
        },
        check: (_before, after): ReceiptMismatch[] => {
          const eff = (after as { effect?: unknown } | null)?.effect;
          return eff ? [] : [{ path: "effect", expected: ELEMENT_EFFECT_NAME, actual: null, message: "The effect is not on the element after the write." }];
        },
      });
      // What is left, on a fresh render (a separate call from the write).
      const after = await measure("after");
      const left = after.map((m, i) => ({ name: pairsOut[i].name, left_rgb: m.element.rgb.map((x, ci) => r2((x - m.plate.rgb[ci]) * 255)) }));
      const worst = Math.max(...left.flatMap((l) => l.left_rgb.map(Math.abs)));
      return {
        ...head,
        applied: true,
        write: wrote,
        left_after: left,
        worst_left_levels: r2(worst),
        notes: [
          worst > 3
            ? "More than 3 levels are left on a pair: the regions may not be the same material or light, the element may be semi-transparent there, or a Levels cannot make that match (a hue shift needs a different correction)."
            : "Each pair is within 3 levels of its plate area.",
        ],
      };
    },
  },
];
