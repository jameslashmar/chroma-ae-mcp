/**
 * server/src/tools/ext/screenfg.ts
 *
 * ae_screen_foreground: after ae_screen_replace has put an insert on a green or
 * blue screen, keep what passes in front of the screen (a hand, a finger, a pen)
 * over the insert, with its edges, motion blur and the screen's light right:
 *
 * 1. the key: a precomp of a copy of the plate with Keylight (Replace Method
 *    Source, so the subject keeps the plate's own colour; no Key Cleaner and no
 *    Advanced Spill Suppressor, which on a measured plate made the hand see-through
 *    at its edge and moved skin with no spill on it), acting only where the insert
 *    is (its alpha, grown, as the key's matte);
 * 2. the clips, measured: Keylight's raw matte rendered on sample frames and read
 *    on pixels that are surely screen and surely foreground (judged from the plate,
 *    not from Keylight), so the old screen is gone and the subject is solid;
 * 3. the edge, measured: the old screen bled into the subject's edge on the plate
 *    (8-13 levels on a measured laptop plate, 0-4 px deep); the tool fits how much,
 *    takes that much of the old screen colour out through a wrap map (blur(1 - a)
 *    times a) and puts the same amount of the blurred new screen in, so the
 *    fingertip carries the insert's light instead of a green rim;
 * 4. the insert's motion blur: CC Force Motion Blur centred on the frame (phase
 *    -angle / 2) when the screen moves and the insert had none, or had it running
 *    ahead of the track (CC Force Motion Blur's own default phase is 0).
 *
 * Three guarded writes (build or reset; Keylight on with the screen colour; the
 * clips and the wrap), with renders between them, then a check on renders and a
 * before / after sheet of crops round the subject's edge.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError, SLOW_TIMEOUT_MS } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ExpectGuard, type ToolContext, type ToolDefinition } from "../common.js";
import { verifyTargetGuard } from "../mutate.js";
import { defaultFramesDir } from "../render.js";
import { captureCompFrame, decodePngFile } from "./frames.js";
import type { Vec2 } from "./planar-math.js";
import { createRenderBudget, PlanarError } from "./planar.js";
import { encodePng, type RgbaImage } from "./png-utils.js";
import {
  alphaOf,
  classify,
  clipAlpha,
  clipsFrom,
  cornerSpeed,
  cropImage,
  dilate,
  edgeBox,
  erode,
  fitWrap,
  keyQuality,
  maskFromAlpha,
  resizeMask,
  findMarkers,
  hueSat,
  markerMask,
  type Markers,
  swapCheck,
  screenColourInside,
  type ClipPlan,
  type KeyColour,
  type WrapFit,
} from "./screenfg-math.js";
import { drawBeforeAfterSheet, parOf, type SheetShot } from "./screenrep.js";
import { runGuardedWrite } from "./write-runner.js";

const TOOL = "ae_screen_foreground";
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const failure = (e: unknown) => ({ ok: false as const, error: (e as PlanarError).code, message: (e as Error).message });

/** Clip White when no foreground crossed the screen on the measured frames (a measured hand needed 83-85). */
const DEFAULT_CLIP_WHITE = 90;
/** Wrap strength when no edge was seen to fit it on (the measured laptop plate: 0.36). */
const DEFAULT_WRAP = 0.3;
/** Under this the fitted bleed is noise: no wrap. */
const MIN_WRAP = 0.05;
/** Insert corner speed (px a frame, as shown) above which an insert without motion blur gets it. */
const MB_SPEED_PX = 1.5;

// ---------- schema ----------

export const AeScreenForegroundSchema = z.object({
  comp_id: z.number().int(),
  insert: LayerSelectorSchema.describe("The insert layer ae_screen_replace made ('<name> INSERT'): the key acts only inside its alpha (grown by grow_px), and the wrap layers are copies of it."),
  plate: LayerSelectorSchema.optional().describe("The plate layer. Default: the first enabled footage or comp layer below the insert."),
  remove: z.boolean().default(false).describe("true: take the parts of an earlier call out again (the insert is left as it is). Default false: build the parts, or re-tune them when an earlier call made them."),
  name: z.string().min(1).max(150).optional().describe("Base name of the parts ('<name> KEY', '<name> AREA', '<name> WRAP', '<name> wrap IN (new screen)', '<name> wrap OUT (old screen)'). Default: the insert layer's name without ' INSERT'."),
  screen_colour: z.array(z.number().min(0).max(1)).length(3).optional().describe("The screen's key colour [r, g, b], 0..1 display values. Default: measured inside the insert's area on the plate."),
  clip_black: z.number().min(0).max(100).optional().describe("Keylight Clip Black. Default: just above the old screen's raw matte on sure-screen pixels (99.5th percentile + 2)."),
  clip_white: z.number().min(0).max(100).optional().describe("Keylight Clip White. Default: just under the subject's raw matte on sure-foreground pixels (0.5th percentile - 2); 90 when no foreground crossed the screen on the measured frames."),
  wrap: z
    .union([z.enum(["auto", "off"]), z.number().min(0).max(1)])
    .default("auto")
    .describe("The edge: auto (default) fits how much the old screen bled into the subject's edge on the plate and swaps that much for the new screen; off: no wrap; a number 0..1 sets the strength."),
  markers: z
    .union([
      z.enum(["auto", "off"]),
      z.object({
        colour: z.array(z.number().min(0).max(1)).length(3).describe("The markers' colour [r, g, b], 0..1."),
        hue_tolerance_deg: z.number().min(2).max(45).default(15).describe("How far round its hue (degrees) still counts as the markers'. Default 15."),
      }),
    ])
    .default("auto")
    .describe(
      "Tracking markers on the screen (tape, dots or crosses of one colour): auto (default) finds small blobs of one saturated colour that is not the key's inside the area and changes that colour to the key colour before Keylight (Change To Color), so they key out with the screen; off: leave them (they stay over the insert as part of the foreground); or give their colour. Markers that are not a colour (black or white tape) are not handled."
    ),
  wrap_radius_px: z.number().min(1).max(40).optional().describe("Fast Box Blur radius of the wrap map (how deep into the edge it reaches), comp px. Default: fitted among 2, 3, 4 and 6 px per 1080 lines."),
  light_radius_px: z.number().min(0).max(200).optional().describe("Fast Box Blur radius of the screen light (the insert blurred), comp px. Default 8 per 1080 lines."),
  grow_px: z.number().min(0).max(100).optional().describe("How far the key's area reaches beyond the insert's own alpha (Minimax), comp px. Default 6 per 1080 lines."),
  insert_motion_blur: z
    .enum(["auto", "keep"])
    .default("auto")
    .describe("auto (default): CC Force Motion Blur on the insert, centred on the frame (phase -angle / 2, the comp's angle), when the screen moves over 1.5 px a frame and the insert has none, or when its CC Force Motion Blur is not centred; keep: leave the insert alone."),
  times: z.array(z.number().min(0)).min(1).max(24).optional().describe("Seconds to measure on: frames where something crosses the screen. Default: max_samples frames spread over the insert's span."),
  max_samples: z.number().int().min(2).max(24).default(8).describe("Frames to measure on when `times` is not given. Default 8."),
  max_renders: z.number().int().min(6).max(150).default(60).describe("Most renders in the call. Default 60."),
  max_seconds: z.number().min(10).max(900).default(300).describe("Most seconds spent rendering. Default 300."),
  contact_sheet: z.boolean().default(true).describe("Write a before / after sheet of crops round the subject's edge (`sheet_path`). Default true."),
  max_size: z.number().int().min(160).max(1200).default(480).describe("Long edge of one sheet tile in pixels. Default 480."),
  expect: ExpectSchema,
});

export type AeScreenForegroundArgs = z.infer<typeof AeScreenForegroundSchema>;

// ---------- host shapes ----------

interface PartRef {
  index: number;
  id: number;
  source_id?: number | null;
  many?: boolean;
}

interface FgInfo {
  comp: { id: number; name: string; width: number; height: number; pixel_aspect: number; fps: number; duration: number; motion_blur: boolean; shutter_angle: number | null; shutter_phase: number | null };
  ae_version: string;
  can_set_track_matte: boolean;
  has_subtract: boolean;
  name: string;
  insert: {
    index: number;
    id: number;
    name: string;
    locked: boolean;
    enabled: boolean;
    in_point: number;
    out_point: number;
    source_kind: string;
    source_pixel_aspect: number;
    motion_blur: boolean;
    opacity_keyed: boolean;
    effects: Array<{ index: number; match: string; name: string; enabled: boolean }>;
    pin: string | null;
    force_mb: { enabled: boolean; override: number | null; angle: number | null; phase: number | null } | null;
    frames: Array<{ t: number; c: number[][]; p: number[] }>;
    frames_truncated: boolean;
  };
  plate: { index: number; id: number; name: string; locked: boolean; enabled: boolean; source_kind: string } | null;
  plate_has_keylight: boolean;
  existing: {
    layers: Record<"key" | "area" | "wrap" | "wrap_in" | "wrap_out", PartRef | null>;
    comps: Record<"key" | "area" | "wrap", { id: number; many?: boolean } | null>;
  };
}

interface Parts {
  comps: { key: number; area: number; wrap: number };
  layers: Record<"wrap_in" | "wrap_out" | "wrap" | "key" | "area" | "insert", { index: number; id: number }>;
}

interface ReadLayer {
  index: number;
  id: number;
  name: string;
  enabled: boolean;
  blending_mode: string | null;
  matte_id: number | null;
  matte_type: string;
  opacity: number | null;
  source_id: number | null;
  effects: Array<{ match: string; enabled: boolean; params: Record<string, unknown> }>;
}

interface FgRead {
  layers: Record<string, ReadLayer | null>;
  inner: { key: ReadLayer | null; area: ReadLayer | null; wrap: Array<ReadLayer | null> };
  order: number[];
  comps: { key: { id: number } | null; area: { id: number } | null; wrap: { id: number } | null };
}

// ---------- plumbing ----------

async function queued<T>(ctx: ToolContext, label: string, opId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.queue.run(label, fn);
  } catch (err) {
    if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
    throw err;
  }
}

async function readHost<T>(ctx: ToolContext, opId: string, tag: string, host: string, args: unknown): Promise<T> {
  const res = await ctx.bridge.evalRaw<T>({ id: `${opId}_${tag}`, script: buildJsxCall(host, args), label: `${TOOL} ${tag}`, mutates: false, toolName: TOOL });
  return res.result;
}

async function renderImage(ctx: ToolContext, opId: string, compId: number, time: number, index: number, framesDir: string): Promise<RgbaImage> {
  const s = await captureCompFrame({ ctx, opId, compId, time, frameIndex: index, framesDir, toolName: TOOL });
  try {
    return decodePngFile(s.path);
  } finally {
    fs.rmSync(s.path, { force: true });
  }
}

function isAeBlocked(err: unknown): boolean {
  return err instanceof BridgeError && (err.kind === "timeout" || err.kind === "queued");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- pure planning ----------

/** Frames to measure on: the given times inside the insert's span, else `n` spread over it; snapped to frames. */
export function planTimes(given: number[] | undefined, span: { start: number; end: number }, fps: number, n: number): number[] {
  const f = fps > 0 ? fps : 25;
  const lo = Math.max(0, span.start);
  const hi = Math.max(lo, span.end - 1 / f);
  const snap = (t: number) => Math.round(t * f) / f;
  let out: number[];
  if (given && given.length) out = given.map(snap).filter((t) => t >= lo - 1e-6 && t <= hi + 1e-6);
  else out = Array.from({ length: n }, (_, k) => snap(lo + ((hi - lo) * (k + 0.5)) / n));
  return [...new Set(out.map(r4))].sort((a, b) => a - b);
}

export interface MbPlan {
  set: { angle: number; phase: number } | null;
  note: string | null;
}

/** Whether the insert gets CC Force Motion Blur, or has its phase centred, and why. */
export function planInsertMb(mode: "auto" | "keep", info: Pick<FgInfo, "comp" | "insert">, speed: { max: number; at: number | null }): MbPlan {
  if (mode === "keep") return { set: null, note: null };
  const angle = info.comp.shutter_angle && info.comp.shutter_angle > 0 ? info.comp.shutter_angle : 180;
  const centred = -angle / 2;
  const f = info.insert.force_mb;
  if (f) {
    const phase = f.phase ?? 0;
    const off = f.override !== 1 || Math.abs(phase - centred) > 0.5 || (f.angle !== null && Math.abs(f.angle - angle) > 0.5);
    if (!off) return { set: null, note: null };
    const lead = speed.max > 0 && f.override === 1 ? r2((Math.abs(phase + (f.angle ?? angle) / 2) / 360) * speed.max) : null;
    return {
      set: { angle, phase: centred },
      note:
        `CC Force Motion Blur on the insert had shutter phase ${r2(phase)} (angle ${f.angle ?? "?"}): its blur reached ${phase > centred ? "ahead of" : "behind"} the frame` +
        (lead !== null ? `, so the insert's blur sat up to ${lead} px off the plate's at the fastest frame` : "") +
        `. It now uses the comp's angle (${r2(angle)}) centred on the frame (phase ${r2(centred)}), because the track follows the middle of the plate's blur.`,
    };
  }
  if (info.insert.motion_blur && info.comp.motion_blur) {
    if (info.comp.shutter_phase !== null && Math.abs(info.comp.shutter_phase - centred) > 0.5) {
      return {
        set: null,
        note: `The insert uses layer motion blur with the comp's shutter phase ${r2(info.comp.shutter_phase)}; for a tracked insert it should be centred (${r2(centred)}). The comp setting was left alone because it changes every layer's blur.`,
      };
    }
    return { set: null, note: null };
  }
  if (speed.max > MB_SPEED_PX) {
    return {
      set: { angle, phase: centred },
      note: `The screen moves up to ${r2(speed.max)} px a frame${speed.at !== null ? ` (at ${r2(speed.at)} s)` : ""} and the insert had no motion blur (a camera blurs anything that moves that fast): CC Force Motion Blur was added at the comp's angle (${r2(angle)}), centred on the frame (phase ${r2(centred)}).`,
    };
  }
  return { set: null, note: null };
}

/** The box round a mask's set pixels, grown by `margin`, inside the image; null for an empty mask. */
export function maskBox(mask: Uint8Array, w: number, h: number, margin: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const bx = Math.max(0, x0 - margin);
  const by = Math.max(0, y0 - margin);
  return { x: bx, y: by, w: Math.min(w, x1 + margin + 1) - bx, h: Math.min(h, y1 + margin + 1) - by };
}

function cropMask(m: Uint8Array | Float32Array, w: number, b: { x: number; y: number; w: number; h: number }): Uint8Array | Float32Array {
  const out = m instanceof Float32Array ? new Float32Array(b.w * b.h) : new Uint8Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) out.set(m.subarray((b.y + y) * w + b.x, (b.y + y) * w + b.x + b.w), y * b.w);
  return out;
}

// ---------- receipt checks ----------

function expectThat(m: ReceiptMismatch[], ok: boolean, p: string, expected: unknown, actual: unknown, message: string): void {
  if (!ok) m.push({ path: p, expected, actual, message });
}

function paramOf(l: ReadLayer | null, match: string, param: string): unknown {
  const e = l?.effects.filter((x) => x.match === match).pop();
  return e ? e.params[param] : undefined;
}

function near(a: unknown, b: number, tol = 1e-3): boolean {
  return typeof a === "number" && Math.abs(a - b) <= tol;
}

function nearColour(a: unknown, c: number[], tol = 2e-3): boolean {
  return Array.isArray(a) && a.length >= 3 && [0, 1, 2].every((i) => Math.abs(Number(a[i]) - c[i]) <= tol);
}

export function structureMismatches(read: FgRead, parts: Parts, grow: number): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const L = read.layers;
  for (const k of ["wrap_in", "wrap_out", "wrap", "key", "area", "insert"] as const) expectThat(m, !!L[k], `layers.${k}`, "present", null, `The ${k} layer is missing after the write`);
  if (m.length) return m;
  const order = ["wrap_in", "wrap_out", "wrap", "key", "area", "insert"].map((k) => L[k]!.index);
  expectThat(m, order.every((v, i) => i === 0 || v > order[i - 1]), "order", "wrap IN, wrap OUT, WRAP, KEY, AREA, insert (top down)", order, "The parts are not in order above the insert");
  expectThat(m, L.key!.matte_id === parts.layers.area.id && L.key!.matte_type === "alpha", "key.matte", { id: parts.layers.area.id, type: "alpha" }, { id: L.key!.matte_id, type: L.key!.matte_type }, "The KEY layer is not matted by the AREA's alpha");
  for (const k of ["wrap_in", "wrap_out"] as const) {
    expectThat(m, L[k]!.matte_id === parts.layers.wrap.id && L[k]!.matte_type === "luma", `${k}.matte`, { id: parts.layers.wrap.id, type: "luma" }, { id: L[k]!.matte_id, type: L[k]!.matte_type }, `The ${k} layer is not luma-matted by WRAP`);
  }
  expectThat(m, L.wrap_in!.blending_mode === "add", "wrap_in.blending_mode", "add", L.wrap_in!.blending_mode, "wrap IN is not in Add");
  expectThat(m, L.wrap_out!.blending_mode === "subtract", "wrap_out.blending_mode", "subtract", L.wrap_out!.blending_mode, "wrap OUT is not in Subtract");
  expectThat(m, L.wrap!.enabled === false && L.area!.enabled === false, "mattes.enabled", false, { wrap: L.wrap!.enabled, area: L.area!.enabled }, "A matte layer is switched on, so it shows");
  expectThat(m, !!read.inner.key?.effects.some((e) => e.match === "Keylight 906"), "key.keylight", "present", null, "No Keylight in the KEY comp");
  expectThat(m, paramOf(read.inner.key, "Keylight 906", "Keylight 906-0019") === 2, "key.replace_method", 2, paramOf(read.inner.key, "Keylight 906", "Keylight 906-0019"), "Keylight's Replace Method is not Source");
  expectThat(m, near(paramOf(read.inner.area, "ADBE Minimax", "ADBE Minimax-0002"), grow), "area.grow_px", grow, paramOf(read.inner.area, "ADBE Minimax", "ADBE Minimax-0002"), "The AREA's Minimax radius did not stick");
  const wrapBlend = read.inner.wrap.find((l) => l?.name === "alpha");
  expectThat(m, wrapBlend?.blending_mode === "multiply", "wrap_comp.alpha.blending_mode", "multiply", wrapBlend?.blending_mode, "The WRAP comp's alpha layer is not in Multiply");
  return m;
}

export interface SetPlan {
  keylight?: { enabled?: boolean; colour?: number[]; clip_black?: number; clip_white?: number; despot_white?: number };
  wrap?: { opacity?: number; colour?: number[]; map_radius?: number; light_radius?: number };
  grow_px?: number;
  insert_mb?: { angle: number; phase: number } | null;
  /** Change To Color before Keylight (the markers to the key colour); null removes it. */
  markers?: { from: number[]; to: number[]; hue_tolerance: number; softness: number } | null;
}

export function setMismatches(read: FgRead, plan: SetPlan): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const key = read.inner.key;
  const kl = plan.keylight;
  if (kl) {
    const e = key?.effects.filter((x) => x.match === "Keylight 906").pop();
    if (kl.enabled !== undefined) expectThat(m, e?.enabled === kl.enabled, "keylight.enabled", kl.enabled, e?.enabled, "Keylight's on/off did not stick");
    if (kl.colour) expectThat(m, nearColour(paramOf(key, "Keylight 906", "Keylight 906-0004"), kl.colour), "keylight.colour", kl.colour, paramOf(key, "Keylight 906", "Keylight 906-0004"), "Keylight's Screen Colour did not stick");
    if (kl.clip_black !== undefined) expectThat(m, near(paramOf(key, "Keylight 906", "Keylight 906-0012"), kl.clip_black, 0.01), "keylight.clip_black", kl.clip_black, paramOf(key, "Keylight 906", "Keylight 906-0012"), "Clip Black did not stick");
    if (kl.clip_white !== undefined) expectThat(m, near(paramOf(key, "Keylight 906", "Keylight 906-0013"), kl.clip_white, 0.01), "keylight.clip_white", kl.clip_white, paramOf(key, "Keylight 906", "Keylight 906-0013"), "Clip White did not stick");
    if (kl.despot_white !== undefined) expectThat(m, near(paramOf(key, "Keylight 906", "Keylight 906-0018"), kl.despot_white, 0.01), "keylight.despot_white", kl.despot_white, paramOf(key, "Keylight 906", "Keylight 906-0018"), "Screen Despot White did not stick");
  }
  const w = plan.wrap;
  if (w) {
    for (const k of ["wrap_in", "wrap_out"] as const) {
      const l = read.layers[k];
      if (w.opacity !== undefined) expectThat(m, near(l?.opacity, w.opacity, 0.01), `${k}.opacity`, w.opacity, l?.opacity, `${k}'s opacity did not stick`);
      if (w.light_radius !== undefined) expectThat(m, near(paramOf(l, "ADBE Box Blur2", "ADBE Box Blur2-0001"), w.light_radius, 0.01), `${k}.light_radius`, w.light_radius, paramOf(l, "ADBE Box Blur2", "ADBE Box Blur2-0001"), `${k}'s blur did not stick`);
    }
    if (w.colour) expectThat(m, nearColour(paramOf(read.layers.wrap_out, "ADBE Fill", "ADBE Fill-0002"), w.colour), "wrap_out.colour", w.colour, paramOf(read.layers.wrap_out, "ADBE Fill", "ADBE Fill-0002"), "wrap OUT's Fill colour did not stick");
    if (w.map_radius !== undefined) {
      const blur = read.inner.wrap.find((l) => l?.effects.some((e) => e.match === "ADBE Invert")) ?? null;
      expectThat(m, near(paramOf(blur, "ADBE Box Blur2", "ADBE Box Blur2-0001"), w.map_radius, 0.01), "wrap_comp.map_radius", w.map_radius, paramOf(blur, "ADBE Box Blur2", "ADBE Box Blur2-0001"), "The WRAP map's blur did not stick");
    }
  }
  if (plan.grow_px !== undefined) expectThat(m, near(paramOf(read.inner.area, "ADBE Minimax", "ADBE Minimax-0002"), plan.grow_px), "area.grow_px", plan.grow_px, paramOf(read.inner.area, "ADBE Minimax", "ADBE Minimax-0002"), "The AREA's Minimax radius did not stick");
  if (plan.markers) {
    const fx = key?.effects ?? [];
    const iC = fx.findIndex((e) => e.match === "ADBE Change To Color");
    const iK = fx.findIndex((e) => e.match === "Keylight 906");
    expectThat(m, iC >= 0 && iK >= 0 && iC < iK, "markers.order", "Change To Color before Keylight", fx.map((e) => e.match), "Change To Color is missing, or not before Keylight, in the KEY comp");
    expectThat(m, nearColour(paramOf(key, "ADBE Change To Color", "ADBE Change To Color-0001"), plan.markers.from), "markers.from", plan.markers.from, paramOf(key, "ADBE Change To Color", "ADBE Change To Color-0001"), "Change To Color's From did not stick");
    expectThat(m, nearColour(paramOf(key, "ADBE Change To Color", "ADBE Change To Color-0002"), plan.markers.to), "markers.to", plan.markers.to, paramOf(key, "ADBE Change To Color", "ADBE Change To Color-0002"), "Change To Color's To did not stick");
  } else if (plan.markers === null) {
    expectThat(m, !(key?.effects ?? []).some((e) => e.match === "ADBE Change To Color"), "markers.removed", "no Change To Color", "present", "Change To Color is still in the KEY comp");
  }
  if (plan.insert_mb) {
    const ins = read.layers.insert;
    expectThat(m, near(paramOf(ins, "CC Force Motion Blur", "CC Force Motion Blur-0005"), plan.insert_mb.phase, 0.01), "insert.force_mb.phase", plan.insert_mb.phase, paramOf(ins, "CC Force Motion Blur", "CC Force Motion Blur-0005"), "The insert's CC Force Motion Blur phase did not stick");
    expectThat(m, near(paramOf(ins, "CC Force Motion Blur", "CC Force Motion Blur-0003"), plan.insert_mb.angle, 0.01), "insert.force_mb.angle", plan.insert_mb.angle, paramOf(ins, "CC Force Motion Blur", "CC Force Motion Blur-0003"), "The insert's CC Force Motion Blur angle did not stick");
  }
  return m;
}

// ---------- the tool ----------

function partsFromExisting(ex: FgInfo["existing"], insert: { index: number; id: number }): Parts | null {
  const l = ex.layers;
  const c = ex.comps;
  if (!l.key || !l.area || !l.wrap || !l.wrap_in || !l.wrap_out || !c.key || !c.area || !c.wrap) return null;
  return {
    comps: { key: c.key.id, area: c.area.id, wrap: c.wrap.id },
    layers: {
      wrap_in: { index: l.wrap_in.index, id: l.wrap_in.id },
      wrap_out: { index: l.wrap_out.index, id: l.wrap_out.id },
      wrap: { index: l.wrap.index, id: l.wrap.id },
      key: { index: l.key.index, id: l.key.id },
      area: { index: l.area.index, id: l.area.id },
      insert,
    },
  };
}

function readFor(args: { comp_id: number }, parts: Parts) {
  return {
    host: "screenfgRead",
    args: {
      comp_id: args.comp_id,
      layer_ids: Object.fromEntries(Object.entries(parts.layers).map(([k, v]) => [k, v.id])),
      comps: parts.comps,
    },
    timeoutMs: SLOW_TIMEOUT_MS,
  };
}

async function screenForeground(ctx: ToolContext, args: AeScreenForegroundArgs): Promise<Record<string, unknown>> {
  const opId = ctx.bridge.newOpId();
  const framesDir = defaultFramesDir();
  const label = `${TOOL}(${args.comp_id})`;
  const notes: string[] = [];
  const expect: ExpectGuard = { project_path: args.expect.project_path, comp_id: args.expect.comp_id ?? args.comp_id };

  // ----- read and validate (nothing written) -----
  const info = await queued(ctx, label, opId, async () => {
    ctx.quarantine.assertClear();
    await verifyTargetGuard(ctx, expect, `${opId}_pre`);
    return readHost<FgInfo>(ctx, opId, "info", "screenfgInfo", { comp_id: args.comp_id, insert: args.insert, ...(args.plate ? { plate: args.plate } : {}), ...(args.name ? { name: args.name } : {}) });
  });
  const name = info.name;
  const ex = info.existing;
  const many = [...Object.entries(ex.layers), ...Object.entries(ex.comps)].filter(([, v]) => v && (v as { many?: boolean }).many).map(([k]) => k);
  if (many.length) throw new PlanarError("refused", `More than one layer or comp carries the name of a part (${many.join(", ")}) for "${name}": rename the extras, or pass another name.`);
  const insertRef = { index: info.insert.index, id: info.insert.id };
  const existing = partsFromExisting(ex, insertRef);
  const anyExisting = Object.values(ex.layers).some(Boolean) || Object.values(ex.comps).some(Boolean);

  if (args.remove) {
    if (!anyExisting) return { ok: true, applied: false, no_op: true, name, message: `No parts of ae_screen_foreground named "${name}" are in the project.` };
    const removeParts = {
      comps: { key: ex.comps.key?.id ?? null, area: ex.comps.area?.id ?? null, wrap: ex.comps.wrap?.id ?? null },
      layers: Object.fromEntries(Object.entries(ex.layers).filter(([, v]) => v).map(([k, v]) => [k, { index: v!.index, id: v!.id }])),
    };
    const res = await runGuardedWrite(ctx, { toolName: TOOL, label: `${label} remove`, expect, compId: args.comp_id, write: { host: "screenfgApply", args: { comp_id: args.comp_id, mode: "remove", name, parts: removeParts } } });
    const w = res as unknown as { removed?: unknown; no_op?: boolean; op_id: string; checkpoint: unknown; receipt: unknown };
    return { ok: true, applied: w.no_op !== true, removed_parts: true, name, removed: w.removed ?? null, notes: ["The insert layer was left as it is, including any CC Force Motion Blur this tool added to it."], checkpoint: w.checkpoint, receipt: w.receipt };
  }

  if (!info.plate) throw new PlanarError("bad_args", "No plate layer was found below the insert (an enabled footage or comp layer): name it as `plate`.");
  if (info.plate.id === info.insert.id) throw new PlanarError("bad_args", "The insert and the plate are the same layer.");
  if (info.insert.locked) throw new PlanarError("refused", `The insert layer "${info.insert.name}" is locked; unlock it first.`);
  if (info.plate.locked) throw new PlanarError("refused", `The plate layer "${info.plate.name}" is locked; unlock it first.`);
  if (!info.can_set_track_matte) throw new PlanarError("refused", `The key and the wrap need layer-based track mattes (After Effects 23 or later); this is AE ${info.ae_version}.`);
  if (!info.has_subtract) throw new PlanarError("refused", "This AE has no Subtract blending mode, which the wrap needs.");
  if (info.plate_has_keylight) throw new PlanarError("refused", `The plate "${info.plate.name}" already has Keylight on it: the key here is made on a copy of the plate as it was shot. Turn that Keylight off, or name the unkeyed plate.`);
  if (!existing && anyExisting) {
    const have = [...Object.entries(ex.layers), ...Object.entries(ex.comps)].filter(([, v]) => v).map(([k]) => k);
    throw new PlanarError("refused", `Some parts of an earlier ae_screen_foreground named "${name}" are here (${have.join(", ")}) and some are missing: call it with remove: true, then again.`);
  }
  if (!existing && info.insert.opacity_keyed) throw new PlanarError("refused", "The insert's Opacity is keyframed; the wrap layers copy it and set their own opacity. Remove the keys or bake them into the insert comp first.");
  if (!info.insert.pin) notes.push("The insert has no CC Power Pin or Corner Pin: its alpha is used as the area as it is, and its speed could not be read.");

  const comp = info.comp;
  const par = parOf(comp.pixel_aspect);
  const scale = comp.height / 1080;
  const grow = args.grow_px ?? Math.max(2, Math.round(6 * scale));
  const lightRadius = args.light_radius_px ?? Math.max(2, Math.round(8 * scale));
  const radii = args.wrap_radius_px !== undefined ? [args.wrap_radius_px] : [...new Set([2, 3, 4, 6].map((r) => Math.max(1, Math.round(r * scale))))];
  const times = planTimes(args.times, { start: info.insert.in_point, end: Math.min(comp.duration, info.insert.out_point) }, comp.fps, args.max_samples);
  if (times.length === 0) throw new PlanarError("bad_args", `None of the times falls inside the insert layer's span (${r2(info.insert.in_point)}-${r2(info.insert.out_point)} s).`);
  const srcPar = info.insert.source_pixel_aspect > 0 ? info.insert.source_pixel_aspect : 1;
  const speed = cornerSpeed(
    info.insert.frames.map((f) => ({ time: f.t, corners: f.c.map((c) => [(c[0] * srcPar) / par + f.p[0], c[1] + f.p[1]] as Vec2) })),
    par
  );
  const mb = planInsertMb(args.insert_motion_blur, info, speed);
  if (mb.note) notes.push(mb.note);
  const budget = createRenderBudget({ maxRenders: args.max_renders, maxSeconds: args.max_seconds });
  fs.mkdirSync(framesDir, { recursive: true });
  const receipts: unknown[] = [];
  let checkpoint: unknown = null;

  // ----- write 1: build, or reset what an earlier call made -----
  let parts: Parts;
  let mode: "built" | "retuned";
  if (existing) {
    parts = existing;
    mode = "retuned";
    const plan: SetPlan = { keylight: { enabled: false, clip_black: 0, clip_white: 100 }, wrap: { opacity: 0, map_radius: radii[0], light_radius: lightRadius }, grow_px: grow, insert_mb: mb.set };
    const res = await runGuardedWrite(ctx, {
      toolName: TOOL,
      label: `${label} reset`,
      expect,
      compId: args.comp_id,
      read: (phase) => (phase === "before" ? null : readFor(args, parts)),
      write: { host: "screenfgApply", args: { comp_id: args.comp_id, mode: "set", parts, ...plan }, timeoutMs: SLOW_TIMEOUT_MS },
      check: (_b, after) => setMismatches(after as FgRead, plan),
    });
    receipts.push((res as { receipt?: unknown }).receipt);
    checkpoint = (res as { checkpoint?: unknown }).checkpoint ?? null;
  } else {
    mode = "built";
    const res = await runGuardedWrite<Record<string, unknown>>(ctx, {
      toolName: TOOL,
      label: `${label} build`,
      expect,
      compId: args.comp_id,
      read: (phase, written) => {
        if (phase === "before") return null;
        const w = written as unknown as { comps?: Record<string, { id: number }>; layers?: Parts["layers"] };
        if (!w?.comps || !w.layers) return null;
        return readFor(args, { comps: { key: w.comps.key.id, area: w.comps.area.id, wrap: w.comps.wrap.id }, layers: w.layers });
      },
      write: {
        host: "screenfgApply",
        args: {
          comp_id: args.comp_id,
          mode: "build",
          name,
          insert: insertRef,
          plate: { index: info.plate.index, id: info.plate.id },
          grow_px: grow,
          map_radius: radii[0],
          light_radius: lightRadius,
          ...(mb.set ? { insert_mb: mb.set } : {}),
        },
        timeoutMs: SLOW_TIMEOUT_MS,
      },
      check: (_b, after, written) => {
        const w = written as unknown as { comps: Record<string, { id: number }>; layers: Parts["layers"] };
        const p: Parts = { comps: { key: w.comps.key.id, area: w.comps.area.id, wrap: w.comps.wrap.id }, layers: w.layers };
        return [...structureMismatches(after as FgRead, p, grow), ...(mb.set ? setMismatches(after as FgRead, { insert_mb: mb.set }) : [])];
      },
    });
    const w = res as unknown as { comps: Record<string, { id: number }>; layers: Parts["layers"]; receipt: unknown; checkpoint: unknown };
    parts = { comps: { key: w.comps.key.id, area: w.comps.area.id, wrap: w.comps.wrap.id }, layers: w.layers };
    receipts.push(w.receipt);
    checkpoint = w.checkpoint ?? null;
  }

  // From here the project holds the parts: nothing below throws; failures come back as a result with what is there.
  const partsOut = { comps: parts.comps, layers: parts.layers };
  const stopped = (error: string, message: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    applied: true,
    error,
    message,
    name,
    mode,
    parts: partsOut,
    ...extra,
    notes,
    checkpoint,
    receipts,
    how_to_remove: `Call ${TOOL} with remove: true (same insert), or undo.`,
  });

  try {
    // ----- render 1: the plate (Keylight still off) and the area -----
    const frames: Array<{ time: number; plate: RgbaImage; inside: Uint8Array }> = [];
    const skipped: string[] = [];
    await queued(ctx, `${label} measure`, opId, async () => {
      let idx = 0;
      for (const t of times) {
        if (budget.exhausted()) break;
        try {
          const plate = await renderImage(ctx, `${opId}_plate`, parts.comps.key, t, idx++, framesDir);
          budget.spend();
          const area = await renderImage(ctx, `${opId}_area`, parts.comps.area, t, idx++, framesDir);
          budget.spend();
          let mask = maskFromAlpha(area, 128);
          if (area.width !== plate.width || area.height !== plate.height) mask = resizeMask(mask, area.width, area.height, plate.width, plate.height);
          const box = maskBox(mask, plate.width, plate.height, 0);
          if (!box) {
            skipped.push(`${r2(t)} s: the insert is not on screen`);
            continue;
          }
          const s = plate.height / comp.height;
          const inset = Math.round(grow * s + 0.04 * Math.min(box.w, box.h) + 2);
          frames.push({ time: t, plate, inside: erode(mask, plate.width, plate.height, inset) });
        } catch (err) {
          if (isAeBlocked(err)) throw err;
          skipped.push(`${r2(t)} s: ${errMessage(err)}`);
        }
      }
    });
    if (frames.length === 0) return stopped("no_frames", `No measuring frame could be rendered (${skipped.slice(0, 3).join("; ") || "render budget"}).`, { skipped });

    // ----- the key colour -----
    let key: KeyColour | null;
    if (args.screen_colour) {
      const c = args.screen_colour as [number, number, number];
      const dom: 1 | 2 = c[2] > c[1] ? 2 : 1;
      key = { rgb: c, dom, excess: dom === 1 ? c[1] - Math.max(c[0], c[2]) : c[2] - Math.max(c[0], c[1]), pixels: 0, coverage: 1 };
      if (!(key.excess > 0.05)) return stopped("bad_args", `screen_colour ${JSON.stringify(c)} is not a green or blue key colour.`);
    } else {
      key = screenColourInside(frames.map((f) => ({ img: f.plate, inside: f.inside })));
      if (!key) {
        return stopped(
          "not_a_key_screen",
          "Inside the insert's area the plate is not mostly one green or blue key colour (under 25% of it, or too little saturation): there is nothing to key. A screen showing a picture needs a roto or a difference matte of what crosses it instead. Remove these parts with remove: true."
        );
      }
    }

    // ----- tracking markers on the screen: their colour changed to the key's before Keylight -----
    let markers: Markers | null = null;
    if (typeof args.markers === "object") {
      const c = args.markers.colour;
      markers = { rgb: [c[0], c[1], c[2]], hue: hueSat(c[0], c[1], c[2]).hue, spread_deg: args.markers.hue_tolerance_deg, blobs: 0, px: 0 };
    } else if (args.markers === "auto") {
      markers = findMarkers(frames.map((f) => ({ img: f.plate, inside: f.inside })), key);
    }
    // Change To Color's Hue tolerance covers about +-tolerance x 180 degrees (measured on AE 27.0).
    const markerPlan = markers ? { from: markers.rgb, to: key.rgb, hue_tolerance: r3(Math.min(0.25, Math.max(0.04, (markers.spread_deg + 8) / 180))), softness: 0.3 } : null;
    if (markers) {
      notes.push(
        `Tracking markers on the screen${markers.blobs ? ` (${markers.blobs} blob(s) over the measured frames)` : ""}: their colour (hue ${r2(markers.hue)} degrees, within ${r2(markers.spread_deg)}) is changed to the key colour before Keylight, so they key out with the screen. Anything in front of the screen in that colour keys out too: pass markers "off", or their colour with a narrower hue_tolerance_deg.`
      );
    }

    // ----- write 2: Keylight on with the colour, clips open -----
    const clipsGiven = args.clip_black !== undefined && args.clip_white !== undefined;
    const plan2: SetPlan = {
      // A marker's light rim (neither its colour nor the key's) stays as a 1-2 px outline after both: Screen Despot
      // White takes such thin leftovers out (on the Painting board, 1.8% of a marker's crop opaque before, 0 after,
      // the hand unchanged).
      keylight: { enabled: true, colour: key.rgb, clip_black: clipsGiven ? args.clip_black : 0, clip_white: clipsGiven ? args.clip_white : 100, despot_white: markers ? Math.max(2, Math.round((3 * comp.height) / 1080)) : 0 },
      markers: markerPlan,
    };
    const res2 = await runGuardedWrite(ctx, {
      toolName: TOOL,
      label: `${label} key`,
      expect,
      compId: args.comp_id,
      read: (phase) => (phase === "before" ? null : readFor(args, parts)),
      write: { host: "screenfgApply", args: { comp_id: args.comp_id, mode: "set", parts, ...plan2 }, timeoutMs: SLOW_TIMEOUT_MS },
      check: (_b, after) => setMismatches(after as FgRead, plan2),
    });
    receipts.push((res2 as { receipt?: unknown }).receipt);

    // ----- render 2: Keylight's raw matte -----
    const raws: Float32Array[] = [];
    await queued(ctx, `${label} matte`, opId, async () => {
      let idx = 100;
      for (const f of frames) {
        if (budget.exhausted()) break;
        const img = await renderImage(ctx, `${opId}_raw`, parts.comps.key, f.time, idx++, framesDir);
        budget.spend();
        raws.push(img.width === f.plate.width && img.height === f.plate.height ? alphaOf(img) : new Float32Array(f.plate.width * f.plate.height));
      }
    });
    const used = frames.slice(0, raws.length);
    const classes = used.map((f) => classify(f.plate, f.inside, key!, 3, markers));
    const clipPlan: ClipPlan = clipsFrom(used.map((f, i) => ({ alpha: raws[i], screen: classes[i].screen, fg: classes[i].fg })));
    let clipBlack = args.clip_black ?? clipPlan.black;
    let clipWhite = args.clip_white ?? clipPlan.white ?? DEFAULT_CLIP_WHITE;
    if (args.clip_white === undefined && clipPlan.white === null) {
      notes.push(`Nothing crossed the screen on the measured frames (${clipPlan.fg_px} sure-foreground pixels), so Clip White is a default ${DEFAULT_CLIP_WHITE}. Give \`times\` where a hand or object covers part of the screen and call again.`);
    }
    if (clipWhite <= clipBlack + 5) {
      notes.push(`The screen and the subject are close in Keylight's matte (Clip Black ${clipBlack}, Clip White ${clipWhite}): the subject has colours near the screen's. Check the key on the sheet.`);
      clipWhite = Math.min(100, clipBlack + 20);
    }
    if (clipsGiven) {
      clipBlack = args.clip_black!;
      clipWhite = args.clip_white!;
    }
    const alphas = used.map((f, i) => (clipsGiven ? raws[i] : clipAlpha(raws[i], clipBlack, clipWhite)));

    // ----- the wrap, fitted on the plate inside the area (cropped to it) -----
    let wrapFit: WrapFit | null = null;
    let strength = 0;
    let mapRadius = radii[0];
    if (args.wrap === "off") strength = 0;
    else {
      const margin = 3 * Math.max(...radii) + 16;
      const cropped = used.flatMap((f, i) => {
        const b = maskBox(f.inside, f.plate.width, f.plate.height, margin);
        if (!b) return [];
        return [{ plate: cropImage(f.plate, b.x, b.y, b.w, b.h), alpha: cropMask(alphas[i], f.plate.width, b) as Float32Array, inside: cropMask(f.inside, f.plate.width, b) as Uint8Array }];
      });
      const s = used.length ? used[0].plate.height / comp.height : 1;
      wrapFit = fitWrap(cropped, key, radii.map((r) => Math.max(1, Math.round(r * s))));
      if (wrapFit) mapRadius = Math.max(1, Math.round(wrapFit.radius / s));
      if (typeof args.wrap === "number") strength = args.wrap;
      else if (!wrapFit) {
        strength = DEFAULT_WRAP;
        notes.push(`No edge of a subject was seen inside the screen on the measured frames, so the wrap strength is a default ${DEFAULT_WRAP}. Give \`times\` where something crosses the screen to fit it.`);
      } else if (wrapFit.strength < MIN_WRAP) {
        strength = 0;
        notes.push(`The subject's edge shows almost none of the old screen (fitted ${wrapFit.strength}, ${wrapFit.rim_screen_pct}% of the edge), so no wrap was added.`);
      } else {
        strength = wrapFit.strength;
        if (wrapFit.unclamped > 1.1) notes.push(`The edge holds more of the old screen than one wrap layer at 100% takes out (fitted ${wrapFit.unclamped} at the widest radius): some green may stay in the edge. Lower clip_white a little, or raise wrap_radius_px.`);
      }
    }

    // ----- write 3: the clips and the wrap -----
    const plan3: SetPlan = {
      keylight: clipsGiven ? undefined : { clip_black: clipBlack, clip_white: clipWhite },
      wrap: { opacity: r2(strength * 100), colour: key.rgb, map_radius: mapRadius, light_radius: lightRadius },
    };
    const res3 = await runGuardedWrite(ctx, {
      toolName: TOOL,
      label: `${label} tune`,
      expect,
      compId: args.comp_id,
      read: (phase) => (phase === "before" ? null : readFor(args, parts)),
      write: { host: "screenfgApply", args: { comp_id: args.comp_id, mode: "set", parts, ...plan3 }, timeoutMs: SLOW_TIMEOUT_MS },
      check: (_b, after) => setMismatches(after as FgRead, plan3),
    });
    receipts.push((res3 as { receipt?: unknown }).receipt);

    // ----- render 3: the finished key and the comp, on the frames with the most in front -----
    const order = used.map((_, i) => i).sort((a, b) => classes[b].fg.reduce((s, v) => s + v, 0) - classes[a].fg.reduce((s, v) => s + v, 0));
    const pick = order.slice(0, Math.min(4, order.length)).sort((a, b) => a - b);
    const finals: Array<{ i: number; keyed: RgbaImage; comp: RgbaImage }> = [];
    await queued(ctx, `${label} check`, opId, async () => {
      let idx = 200;
      for (const i of pick) {
        if (budget.exhausted()) break;
        try {
          const keyed = await renderImage(ctx, `${opId}_keyed`, parts.comps.key, used[i].time, idx++, framesDir);
          budget.spend();
          const out = await renderImage(ctx, `${opId}_comp`, args.comp_id, used[i].time, idx++, framesDir);
          budget.spend();
          finals.push({ i, keyed, comp: out });
        } catch (err) {
          if (isAeBlocked(err)) break;
          skipped.push(`check at ${r2(used[i].time)} s: ${errMessage(err)}`);
        }
      }
    });
    const same = (a: RgbaImage, b: RgbaImage) => a.width === b.width && a.height === b.height;
    const qFrames = finals.filter((f) => same(f.keyed, used[f.i].plate));
    const quality = qFrames.length ? keyQuality(qFrames.map((f) => ({ plate: used[f.i].plate, keyed: f.keyed, screen: classes[f.i].screen, fg: classes[f.i].fg }))) : null;
    // The markers' own pixels (by colour on the plate) that the key still shows.
    let markersLeft: number | null = null;
    if (markers && qFrames.length) {
      let n = 0;
      let left = 0;
      for (const f of qFrames) {
        // The markers and a 2 px ring round them, where their light rim was.
        const mm = dilate(markerMask(used[f.i].plate, used[f.i].inside, markers), used[f.i].plate.width, used[f.i].plate.height, 2);
        for (let i = 0; i < mm.length; i++) {
          if (!mm[i]) continue;
          n++;
          if (f.keyed.data[i * 4 + 3] > 127) left++;
        }
      }
      markersLeft = n ? r2((left / n) * 100) : null;
      if (markersLeft !== null && markersLeft > 5) notes.push(`${markersLeft}% of the markers' pixels still show over the insert: give their colour with a wider hue_tolerance_deg.`);
    }
    const s = used[0].plate.height / comp.height;
    const rRender = Math.max(1, Math.round(mapRadius * s));
    const rim = finals
      .filter((f) => same(f.comp, used[f.i].plate) && same(f.keyed, used[f.i].plate))
      .map((f) => {
        const a = alphaOf(f.keyed);
        const sw = swapCheck(used[f.i].plate, f.comp, a, used[f.i].inside, key!, rRender);
        return { time: used[f.i].time, ...(sw ?? { plate_share_pct: null, swapped_pct: null, px: 0 }) };
      });
    if (quality && quality.fg_see_through_pct !== null && quality.fg_see_through_pct > 1) notes.push(`${quality.fg_see_through_pct}% of the subject is still see-through (matte under 0.98): lower clip_white.`);
    if (quality && quality.screen_left_p999 !== null && quality.screen_left_p999 > 0.08) notes.push(`Some of the old screen is left over the insert (99.9th percentile matte ${quality.screen_left_p999}): raise clip_black.`);
    if (finals.some((f) => !same(f.comp, used[f.i].plate))) notes.push("The comp renders at another resolution than the KEY comp, so the edge colour was not compared on the comp.");

    // ----- the sheet: crops round the subject's edge, plate above, comp below -----
    let sheetPath: string | undefined;
    if (args.contact_sheet && finals.length) {
      const before: SheetShot[] = [];
      const after: SheetShot[] = [];
      for (const f of finals) {
        const pl = used[f.i].plate;
        if (!same(f.comp, pl) || !same(f.keyed, pl)) continue;
        const box = edgeBox(alphaOf(f.keyed), used[f.i].inside, pl.width, pl.height, Math.round(Math.min(pl.width, pl.height) * 0.22));
        if (!box) continue;
        before.push({ label: "plate", time: used[f.i].time, image: cropImage(pl, box.x, box.y, box.size, box.size) });
        after.push({ label: "comp", time: used[f.i].time, image: cropImage(f.comp, box.x, box.y, box.size, box.size) });
      }
      const png = drawBeforeAfterSheet(before, after, args.max_size);
      if (png) {
        sheetPath = path.join(framesDir, `screenforeground_${opId}.png`);
        fs.writeFileSync(sheetPath, encodePng(png));
      } else notes.push("No frame showed a subject's edge inside the screen, so no sheet was made.");
    }
    if (skipped.length) notes.push(`Not measured: ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? ` (+${skipped.length - 5})` : ""}.`);

    return {
      ok: true,
      applied: true,
      comp_id: args.comp_id,
      name,
      mode,
      parts: partsOut,
      key: {
        screen_colour: key.rgb.map(r4),
        screen_colour_8bit: key.rgb.map((v) => Math.round(v * 255)),
        screen: key.dom === 1 ? "green" : "blue",
        coverage: r3(key.coverage),
        clip_black: clipBlack,
        clip_white: clipWhite,
        measured: clipPlan,
        replace_method: "Source (the subject keeps the plate's colour where the clip made it solid)",
        markers: markers ? { colour_8bit: markers.rgb.map((v) => Math.round(v * 255)), hue_deg: r2(markers.hue), spread_deg: r2(markers.spread_deg), blobs: markers.blobs, hue_tolerance: markerPlan?.hue_tolerance ?? null, left_pct: markersLeft } : null,
      },
      wrap: { strength: r4(strength), map_radius_px: mapRadius, light_radius_px: lightRadius, fit: wrapFit },
      insert_motion_blur: { set: mb.set, speed_px_per_frame: speed },
      check: { frames: finals.map((f) => r4(used[f.i].time)), quality, edge: rim, note: "quality is judged on pixels the plate says are surely screen or surely foreground. edge: plate_share_pct is how much of the old screen's colour the subject's edge holds over its middle (brightness aside), and swapped_pct how much of it the comp replaced with the insert's colour next to the edge (100 a full swap, under it some old screen left, over it too much)." },
      measured_on: used.map((f) => r4(f.time)),
      ...(sheetPath ? { sheet_path: sheetPath } : {}),
      budget: { ...budget.used, max_renders: args.max_renders, max_seconds: args.max_seconds },
      notes,
      checkpoint,
      receipts,
    };
  } catch (err) {
    return stopped(err instanceof PlanarError ? err.code : "failed", `Stopped after the parts were made: ${errMessage(err)}`);
  }
}

export const screenfgTools: ToolDefinition<any>[] = [
  {
    name: TOOL,
    description:
      "Keep what passes in front of a replaced green or blue screen (a hand, a finger, a pen) over the insert, after ae_screen_replace: the key, its edges, the screen's light on the subject and the insert's motion blur, measured on renders. " +
      "It builds, above the insert: '<name> KEY' (a precomp of a copy of the plate with Keylight, Replace Method Source so the subject keeps the plate's colour; no Key Cleaner or Advanced Spill Suppressor), matted by '<name> AREA' (the insert's alpha grown by grow_px, so the key acts only on the screen); " +
      "'<name> WRAP' (blur(1 - alpha) x alpha, the band just inside the subject's edge) as the luma matte of '<name> wrap OUT (old screen)' (the insert filled with the old screen colour, blurred, Subtract) and '<name> wrap IN (new screen)' (the insert blurred, Add). " +
      "Measured, in three guarded writes with renders between: the screen colour inside the insert's area; Keylight's Clip Black and Clip White from its raw matte on pixels the plate says are surely screen or surely foreground (so the old screen is gone and the subject is not see-through); how much the old screen bled into the subject's edge on the plate, which is the wrap's strength (the fingertip then carries the new screen's light, not a green rim). " +
      "insert_motion_blur auto adds CC Force Motion Blur to the insert, centred on the frame (phase -angle / 2), when the screen moves and the insert had none, and centres one that was not (its default phase 0 puts the blur ahead of the track). Calling again re-tunes the same parts; remove: true takes them out. " +
      "Returns the measurements, a check on renders (see-through %, old screen left, colour shift of the subject, the edge's colour before and after) and `sheet_path`: crops round the subject's edge, plate above, comp below. Look at it. " +
      "Refuses before writing on a locked insert or plate, a plate that already has Keylight, AE before 23 (layer track mattes), a keyframed insert opacity, and parts of an earlier call that are half there. If the screen turns out not to be a key colour, the parts are already made: the result says so and how to remove them. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeScreenForegroundSchema,
    handler: async (args: AeScreenForegroundArgs, ctx: ToolContext) => {
      try {
        return await screenForeground(ctx, args);
      } catch (err) {
        if (err instanceof PlanarError) return failure(err);
        throw err;
      }
    },
  },
];
