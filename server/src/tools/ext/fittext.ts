/**
 * server/src/tools/ext/fittext.ts
 *
 * Text fitting, each write a guarded write with a read-back in a separate
 * evalScript:
 * - ae_measure_text: read-only. Bounds, size, box state and font state of
 *   text layers, and whether they fit a region.
 * - ae_fit_text: shrink (or grow) the font size until the measured bounds fit
 *   a box or the safe area. Point text is linear in font size, so it measures
 *   once, writes the computed size and verifies; one correction pass at most.
 *   Box text rewraps, so it steps down until nothing overflows, within
 *   `max_passes`. Every pass is its own undo step. Or installs a live-fit
 *   expression on Scale (mode "live").
 * - ae_text_backdrop: a rectangle shape layer sized from the text's bounds by
 *   expression, so it follows the text.
 *
 * Per-word styling is ae_set_text's `ranges` (animate.ts).
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type LayerSelector, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- host shapes ----------

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TextMeasure {
  id: number;
  index: number;
  name: string;
  text_length: number;
  /** Source Text keys: a keyed text isn't fitted (the fit would have to repeat per key). */
  numKeys: number;
  /** Source Text has an expression that would override the written size. */
  expression: boolean;
  /** The layer is locked: AE refuses to change it. */
  locked?: boolean;
  fontSize?: number;
  leading?: number;
  /** Auto leading is on: leading is left alone (writing it would switch to fixed). */
  autoLeading?: boolean;
  tracking?: number;
  justification?: string;
  boxText?: boolean;
  boxTextSize?: number[];
  /** AE 24.6+. Undefined where the build lacks it. */
  boxOverflow?: boolean;
  fontSubstituted?: boolean;
  /** More than one font size in the text (per-range sizes). */
  sizes_vary?: boolean;
  min_run_size?: number;
  max_run_size?: number;
  /** "full" read every character; "probe" compared the first and last only (the scan cap was reached). */
  sizes_scan?: "full" | "probe";
  bounds: Bounds;
  /** foreign: Scale has an expression that is not this tool's. */
  live_fit?: { installed: boolean; error: string | null; foreign?: boolean };
}

export interface MeasureResult {
  comp_id: number;
  comp: { width: number; height: number };
  time: number;
  ranges_supported: boolean;
  layers: TextMeasure[];
  truncated?: boolean;
  /** The per-character size scan hit its cap for this call; later layers were only probed. */
  sizes_scan_capped?: boolean;
  skipped?: Array<{ id: number; name: string; reason: string }>;
}

// ---------- pure logic ----------

export const MIN_FONT_SIZE = 0.1;
export const MAX_FONT_SIZE = 1296;
/** The fraction of the comp each safe area covers. */
export const SAFE_AREAS = { title: 0.8, action: 0.9 } as const;
/** Point text is nearly linear: one correction after the first write; box text rewraps, so it gets the caller's cap. */
export const POINT_TEXT_PASS_CAP = 2;

export interface Region {
  maxW?: number;
  maxH?: number;
}

export function regionOf(a: { max_width?: number; max_height?: number; safe_area?: "title" | "action" }, comp: { width: number; height: number }): Region {
  if (a.safe_area) {
    const f = SAFE_AREAS[a.safe_area];
    return { maxW: comp.width * f, maxH: comp.height * f };
  }
  return { maxW: a.max_width, maxH: a.max_height };
}

/** Within the region, allowing the half-percent rounding AE's own measuring has. */
export function fitsRegion(b: Bounds, r: Region): boolean {
  if (r.maxW !== undefined && b.width > r.maxW * 1.005 + 0.01) return false;
  if (r.maxH !== undefined && b.height > r.maxH * 1.005 + 0.01) return false;
  return true;
}

export interface FitOptions {
  region: Region;
  minSize: number;
  maxSize: number;
  allowGrow: boolean;
}

export type FitPlan =
  | { status: "fits" }
  | { status: "skip"; reason: string }
  | { status: "limit"; reason: string }
  | { status: "resize"; factor: number; from: number; to: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What to do to one measured text layer. Point text: the size that makes the
 * measured bounds hit the region, from the ratio (width and height scale with
 * font size when leading scales with it). Box text: rewraps as the size
 * changes, so the ratio only gives a first step; an overflowing box takes at
 * least a 5% step down, and the next pass measures again. Box text is never
 * grown (a bigger size rewraps unpredictably).
 */
export function planFit(m: TextMeasure, o: FitOptions): FitPlan {
  if (m.expression) return { status: "skip", reason: "Source Text has an expression, which would override a written size" };
  if (m.numKeys > 0) return { status: "skip", reason: "Source Text is keyed; a fit would have to repeat per keyframe" };
  const size = m.fontSize;
  if (typeof size !== "number" || !(size > 0)) return { status: "skip", reason: "the font size could not be read" };
  const b = m.bounds;
  if (!(b.width > 0) || !(b.height > 0)) return { status: "skip", reason: "the text has no measurable bounds (empty text?)" };
  if (m.locked === true) return { status: "skip", reason: "the layer is locked; unlock it to fit it" };
  const box = m.boxText === true;
  const overflow = m.boxOverflow === true;
  const fits = fitsRegion(b, o.region) && !overflow;

  // Box text rewraps to fill its box, so its measured width stays near the box
  // width at any size and the bounds ratio would shrink it again and again.
  // If the box itself is bigger than the region, a smaller font can't fix that.
  const bs = box && Array.isArray(m.boxTextSize) && m.boxTextSize.length === 2 ? m.boxTextSize : null;
  if (box && !fits && bs) {
    if (o.region.maxW !== undefined && bs[0] > o.region.maxW * 1.005 + 0.01) {
      return { status: "limit", reason: `the box itself (${round2(bs[0])} wide) is wider than the region (${round2(o.region.maxW)}); resize the box, a smaller font cannot fix that` };
    }
    if (o.region.maxH !== undefined && bs[1] > o.region.maxH * 1.005 + 0.01) {
      return { status: "limit", reason: `the box itself (${round2(bs[1])} high) is taller than the region (${round2(o.region.maxH)}); resize the box, a smaller font cannot fix that` };
    }
  }

  const ratios: number[] = [];
  // With a known box width the text already fits across; only the height steps it.
  if (o.region.maxW !== undefined && !bs) ratios.push(o.region.maxW / b.width);
  if (o.region.maxH !== undefined) ratios.push(o.region.maxH / b.height);
  let factor = ratios.length ? Math.min(...ratios) : Infinity;

  const grows = o.allowGrow && !box;
  if (fits && (!grows || factor <= 1.005)) return { status: "fits" };
  if (overflow) factor = Math.min(factor, 0.95);
  if (!grows) factor = Math.min(factor, 1);
  if (!Number.isFinite(factor)) return { status: "fits" };
  // A hair under the exact ratio so rounding and kerning don't leave it over.
  if (factor < 1) factor *= 0.998;

  const ceiling = grows ? o.maxSize : Math.min(o.maxSize, size);
  const to = Math.floor(Math.min(Math.max(size * factor, o.minSize, MIN_FONT_SIZE), ceiling, MAX_FONT_SIZE) * 100) / 100;
  if (Math.abs(to - size) <= size * 0.002 + 0.005) {
    const atMin = size * factor < o.minSize;
    return { status: "limit", reason: atMin ? `already at the minimum size (${o.minSize})` : "already at the largest allowed size" };
  }
  return { status: "resize", factor: to / size, from: size, to: round2(to) };
}

/** The most passes a layer gets: point text one write and one correction, box text the caller's cap. */
export function passCap(m: TextMeasure, maxPasses: number): number {
  return m.boxText === true ? maxPasses : Math.min(POINT_TEXT_PASS_CAP, maxPasses);
}

// ---------- schemas ----------

const RegionFields = {
  max_width: z.number().positive().max(100000).optional().describe("Largest width the text may measure, in the layer's own pixels (before Scale)."),
  max_height: z.number().positive().max(100000).optional().describe("Largest height the text may measure, in the layer's own pixels (before Scale)."),
  safe_area: z.enum(["title", "action"]).optional().describe("Instead of max_width/max_height: the comp's title-safe (80%) or action-safe (90%) area."),
};

const regionChosen = (v: { max_width?: number; max_height?: number; safe_area?: string }) =>
  v.safe_area !== undefined || v.max_width !== undefined || v.max_height !== undefined;
const regionExclusive = (v: { max_width?: number; max_height?: number; safe_area?: string }) =>
  v.safe_area === undefined || (v.max_width === undefined && v.max_height === undefined);

export const AeMeasureTextSchema = z
  .object({
    comp_id: z.number().int(),
    layers: z.array(LayerSelectorSchema).min(1).max(100).optional().describe("Text layers to measure. Default: every text layer in the comp (first 500)."),
    time: z.number().min(0).optional().describe("Comp time in seconds to measure at (sourceRectAtTime). Default the comp's current time. Reading never moves the playhead."),
    ...RegionFields,
  })
  .refine(regionExclusive, { message: "Give safe_area or max_width/max_height, not both." });

export const AeFitTextSchema = z
  .object({
    comp_id: z.number().int(),
    layers: z.array(LayerSelectorSchema).min(1).max(100).optional().describe("Text layers to fit. Default: every text layer in the comp."),
    mode: z
      .enum(["size", "live", "unlive"])
      .optional()
      .describe(
        "'size' (default) writes a font size and verifies it. 'live' installs an expression on Transform > Scale that shrinks the layer to fit as its text changes (it only shrinks, never above 100%). 'unlive' removes that expression (only one this tool installed)."
      ),
    ...RegionFields,
    min_size: z.number().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE).optional().describe("Never go below this font size (default 6). A layer that still does not fit is reported, not shrunk further."),
    max_size: z.number().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE).optional().describe("Never go above this font size (default: the current size, or 1296 with allow_grow)."),
    allow_grow: z.boolean().optional().describe("Also grow point text that is smaller than the region. Default false: shrink only. Box text is never grown."),
    scale_leading: z.boolean().optional().describe("Scale a fixed leading by the same factor (default true; auto leading follows by itself). Without it multi-line height is not linear in size."),
    max_passes: z.number().int().min(1).max(4).optional().describe("Most writes per layer (default 3). Point text gets at most 2 (the write and one correction); box text rewraps, so it may need more. Each pass is one undo step."),
    dry_run: z.boolean().optional().describe("Measure and plan only; write nothing."),
    time: z.number().min(0).optional().describe("Comp time in seconds to measure at. Default the comp's current time."),
    expect: ExpectSchema,
  })
  .refine((v) => v.mode === "unlive" || regionChosen(v), { message: "Give safe_area, or max_width and/or max_height." })
  .refine(regionExclusive, { message: "Give safe_area or max_width/max_height, not both." })
  .refine((v) => v.min_size === undefined || v.max_size === undefined || v.min_size <= v.max_size, { message: "min_size is above max_size." });

export const AeTextBackdropSchema = z.object({
  comp_id: z.number().int(),
  layer: LayerSelectorSchema.describe("The text layer to put the box behind."),
  padding: z.array(z.number().min(0).max(5000)).length(2).optional().describe("Padding [x, y] in pixels around the text on each side. Default [24, 12]."),
  color: z.array(z.number().min(0).max(1)).length(3).optional().describe("Fill colour [r, g, b] in 0..1. Default black."),
  opacity: z.number().min(0).max(100).optional().describe("Fill opacity in percent. Default 100."),
  corner_radius: z.number().min(0).max(5000).optional().describe("Rounded corners in pixels. Default 0."),
  name: z.string().min(1).max(200).optional().describe("Name of the shape layer. Default '<text layer> Box'."),
  expect: ExpectSchema,
});

// ---------- tools ----------

type FitArgs = z.infer<typeof AeFitTextSchema>;
type BackdropArgs = z.infer<typeof AeTextBackdropSchema>;

const selectorIds = (items: Array<{ id: number }>): LayerSelector[] => items.map((i) => ({ id: i.id }));
const near = (a: number | undefined, b: number, abs: number) => typeof a === "number" && Math.abs(a - b) <= abs + Math.abs(b) * 0.001;

interface ApplyItem {
  id: number;
  name: string;
  factor: number;
  from: number;
  to: number;
  expect_size: number;
}

/** Receipt checks for one fit pass: the size, the leading, the text and the justification. */
export function fitMismatches(items: ApplyItem[], scaleLeading: boolean, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = beforeRaw as MeasureResult | null;
  const after = afterRaw as MeasureResult | null;
  if (!before || !after) return m;
  for (const it of items) {
    const was = before.layers.find((l) => l.id === it.id);
    const now = after.layers.find((l) => l.id === it.id);
    const tag = `layers[${it.name}]`;
    if (!now) {
      m.push({ path: tag, expected: it.id, actual: undefined, message: "The layer is not in the read-back" });
      continue;
    }
    expectThat(m, near(now.fontSize, it.to, 0.02), `${tag}.fontSize`, it.to, now.fontSize, "Font size differs from the one written");
    if (was) {
      expectThat(m, now.text_length === was.text_length, `${tag}.text_length`, was.text_length, now.text_length, "The text changed");
      if (was.justification !== undefined && now.justification !== undefined) {
        expectThat(m, now.justification === was.justification, `${tag}.justification`, was.justification, now.justification, "Justification changed (the TextDocument round trip can drop it)");
      }
      if (scaleLeading && was.autoLeading !== true && typeof was.leading === "number" && was.leading > 0) {
        const want = Math.min(was.leading * it.factor, 5000);
        expectThat(m, near(now.leading, want, 0.5), `${tag}.leading`, want, now.leading, "Leading was not scaled with the size");
      }
    }
  }
  return m;
}

export function liveMismatches(remove: boolean, afterRaw: unknown, ids: number[]): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as MeasureResult | null;
  if (!after) return m;
  for (const id of ids) {
    const now = after.layers.find((l) => l.id === id);
    if (!now) {
      m.push({ path: `layers[${id}]`, expected: id, actual: undefined, message: "The layer is not in the read-back" });
      continue;
    }
    expectThat(m, (now.live_fit?.installed ?? false) === !remove, `layers[${now.name}].live_fit`, !remove, now.live_fit?.installed ?? false, remove ? "The live-fit expression is still on" : "The live-fit expression is not on");
    if (!remove && now.live_fit?.error) m.push({ path: `layers[${now.name}].live_fit.error`, expected: null, actual: now.live_fit.error, message: "The expression has an error" });
  }
  return m;
}

interface FinalStatus {
  id: number;
  name: string;
  status: "fits" | "limit" | "skip" | "unfitted";
  reason?: string;
  from_size?: number;
  to_size?: number;
  passes: number;
  bounds: Bounds;
  overflow?: boolean;
}

function readHost<T>(ctx: Parameters<ToolDefinition["handler"]>[1], host: string, args: Record<string, unknown>, toolName: string, label: string) {
  return ctx.bridge.callHost<T>(host, args, { label, mutates: false, toolName }).then((r) => r.result);
}

/**
 * The expression ae_fit_text mode 'live' puts on Scale. Keep in step with
 * liveExpression in panel/host/ext/fittext.jsx (a test compares them).
 */
export function liveExpressionText(maxW?: number, maxH?: number): string {
  const lines = ["// chroma-fit-text live", "var r = thisLayer.sourceRectAtTime(time, false);", "var s = 1;"];
  if (typeof maxW === "number") lines.push(`if (r.width > 0) s = Math.min(s, ${maxW} / r.width);`);
  if (typeof maxH === "number") lines.push(`if (r.height > 0) s = Math.min(s, ${maxH} / r.height);`);
  lines.push("value * s;");
  return lines.join("\n");
}

export interface BackdropRead {
  text: {
    id: number;
    index: number;
    name: string;
    bounds: Bounds;
    /** Scale as evaluated, percent. */
    scale?: number[];
    rotation?: number;
    parented?: boolean;
    three_d?: boolean;
  };
  backdrop?: { id: number; index: number; name: string; kind: string; size?: number[]; expression_error: string | null };
}

export function backdropMismatches(args: BackdropArgs, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const after = afterRaw as BackdropRead | null;
  if (!after) return m;
  const b = after.backdrop;
  if (!b) {
    m.push({ path: "backdrop", expected: "a shape layer", actual: undefined, message: "The box layer is not in the read-back" });
    return m;
  }
  expectThat(m, b.kind === "shape", "backdrop.kind", "shape", b.kind, "The box is not a shape layer");
  expectThat(m, b.index === after.text.index + 1, "backdrop.index", after.text.index + 1, b.index, "The box is not directly below the text");
  if (b.expression_error) m.push({ path: "backdrop.expression_error", expected: null, actual: b.expression_error, message: "The size expression has an error" });
  const pad = args.padding ?? [24, 12];
  // The box is the text's bounds in comp space plus padding, so Scale counts.
  // A rotated, parented or 3D text layer makes the box a bounding box of its
  // corners, which this check does not compute: it is left unchecked.
  const t = after.text;
  const plain = (t.rotation === undefined || Math.abs(t.rotation) < 0.0001) && t.parented !== true && t.three_d !== true;
  const sx = Math.abs(t.scale?.[0] ?? 100) / 100;
  const sy = Math.abs(t.scale?.[1] ?? 100) / 100;
  const want = [t.bounds.width * sx + 2 * pad[0], t.bounds.height * sy + 2 * pad[1]];
  if (b.size && !b.expression_error && plain) {
    expectThat(m, near(b.size[0], want[0], 1) && near(b.size[1], want[1], 1), "backdrop.size", want, b.size, "The box is not the text's size (at its Scale) plus padding");
  }
  return m;
}

export const fittextTools: ToolDefinition<any>[] = [
  {
    name: "ae_measure_text",
    description:
      "Measure text layers without changing anything: bounds (sourceRectAtTime) at a time, font size, leading, justification, point or box text, box overflow (AE 24.6+), substituted font, whether the size varies per range, and whether a live-fit expression is on. " +
      "With max_width/max_height or safe_area it also says whether each layer fits. Reading does not move the playhead or the selection. " +
      "Source Text that is keyed is measured at `time` only.",
    schema: AeMeasureTextSchema,
    handler: async (args: z.infer<typeof AeMeasureTextSchema>, ctx) => {
      const res = await readHost<MeasureResult>(
        ctx,
        "fittextMeasure",
        { comp_id: args.comp_id, layers: args.layers, time: args.time },
        "ae_measure_text",
        `ae_measure_text(comp ${args.comp_id})`
      );
      const region = regionOf(args, res.comp);
      const has = region.maxW !== undefined || region.maxH !== undefined;
      return {
        ...res,
        region: has ? region : undefined,
        layers: res.layers.map((l) => (has ? { ...l, fits: fitsRegion(l.bounds, region) && l.boxOverflow !== true } : l)),
      };
    },
  },
  {
    name: "ae_fit_text",
    description:
      "Fit titles into a box or the safe area: shrink (or, with allow_grow, grow) the font size until the measured bounds fit, for chosen text layers or every text layer in the comp, with a min and max size. " +
      "Point text is measured once, the size computed from the ratio and written, then re-measured in a separate evalScript; one correction pass at most. " +
      "Box text rewraps as the size changes, so it steps down until the box no longer overflows (boxOverflow, AE 24.6+) or the region fits, within max_passes; if the box itself is larger than the region it is reported as limit (resize the box), not shrunk. Every pass is its own undo step, guarded by `expect`. " +
      "If a later pass fails, the earlier passes stay applied: the result carries their op_ids, checkpoints and receipts plus a pass_error, and the loop stops. Locked layers are skipped and reported. " +
      "Per-range sizes keep their proportions (each run is scaled, not overwritten), and a fixed leading scales with the size. Keyed Source Text and Source Text with an expression are skipped and reported. " +
      "mode 'live' instead puts an expression on Transform > Scale so the layer shrinks to fit as its text changes; 'unlive' removes it. dry_run plans without writing, in every mode (for live it lists the layers and the expression it would install). " +
      "Each layer ends as fits, limit (min or max size reached), skip (with the reason) or unfitted (passes ran out). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeFitTextSchema,
    handler: async (args: FitArgs, ctx) => {
      const mode = args.mode ?? "size";
      // A fit does not need the per-character size scan, which is the slow part of a measure.
      const measureArgs = { comp_id: args.comp_id, layers: args.layers, time: args.time, sizes: false };
      const first = await readHost<MeasureResult>(ctx, "fittextMeasure", measureArgs, "ae_fit_text", `ae_fit_text(comp ${args.comp_id}) measure`);
      if (first.layers.length === 0) {
        const why = first.skipped && first.skipped.length > 0 ? ` Skipped: ${first.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.` : "";
        return { ok: false, error: "bad_args", message: `No text layers to fit.${why}`, skipped: first.skipped };
      }
      const region = regionOf(args, first.comp);
      const readArgs = (ids: Array<{ id: number }>) => ({ comp_id: args.comp_id, layers: selectorIds(ids), time: first.time, sizes: false });

      if (mode !== "size") {
        const remove = mode === "unlive";
        // Layers this can't change are reported, not sent: locked layers, and (to install) a Scale with someone else's expression.
        const skipped: Array<{ id: number; name: string; reason: string }> = [...(first.skipped ?? [])];
        const targets: TextMeasure[] = [];
        for (const l of first.layers) {
          if (remove) {
            if (!l.live_fit?.installed) skipped.push({ id: l.id, name: l.name, reason: "no live fit from this tool is on" });
            else if (l.locked === true) skipped.push({ id: l.id, name: l.name, reason: "the layer is locked" });
            else targets.push(l);
          } else if (l.locked === true) skipped.push({ id: l.id, name: l.name, reason: "the layer is locked" });
          else if (l.live_fit?.foreign === true) skipped.push({ id: l.id, name: l.name, reason: "Scale already has an expression that is not this tool's" });
          else targets.push(l);
        }
        if (args.dry_run) {
          return {
            ok: true,
            dry_run: true,
            mode,
            region,
            would: targets.map((l) => ({ id: l.id, name: l.name, action: remove ? "remove" : l.live_fit?.installed ? "replace" : "install" })),
            expression: remove ? undefined : liveExpressionText(region.maxW, region.maxH),
            skipped,
          };
        }
        if (targets.length === 0) {
          return { ok: true, applied: false, mode, message: "Nothing to change.", skipped };
        }
        const ids = targets.map((l) => l.id);
        const out = await runGuardedWrite(ctx, {
          toolName: "ae_fit_text",
          label: `ae_fit_text(${mode})`,
          expect: args.expect,
          compId: args.comp_id,
          read: () => ({ host: "fittextMeasure", args: readArgs(targets) }),
          write: {
            host: "fittextLive",
            args: { comp_id: args.comp_id, layers: selectorIds(targets), max_width: region.maxW, max_height: region.maxH, remove, label: remove ? "Remove live fit" : "Live fit text" },
          },
          check: (_b, after) => liveMismatches(remove, after, ids),
          present: (_b, _a, w) => ({ mode, layers: w.layers, skipped }),
        });
        return out;
      }

      const opts: FitOptions = {
        region,
        minSize: args.min_size ?? 6,
        maxSize: args.max_size ?? MAX_FONT_SIZE,
        allowGrow: args.allow_grow === true,
      };
      const maxPasses = args.max_passes ?? 3;
      const scaleLeading = args.scale_leading !== false;
      const startSize = new Map(first.layers.map((l) => [l.id, l.fontSize] as const));
      const used = new Map<number, number>();
      /** Layers whose bounds did not move with the last pass: more passes would only shrink them blindly. */
      const stalled = new Set<number>();
      let current = first.layers;
      let plans = current.map((l) => planFit(l, opts));

      if (args.dry_run) {
        return {
          ok: true,
          dry_run: true,
          region,
          layers: current.map((l, i) => ({ id: l.id, name: l.name, font_size: l.fontSize, bounds: l.bounds, overflow: l.boxOverflow, plan: plans[i] })),
          skipped: first.skipped,
        };
      }

      const passes: Array<Record<string, unknown>> = [];
      let passError: { pass: number; message: string } | undefined;
      for (let pass = 1; pass <= maxPasses; pass++) {
        const items: ApplyItem[] = [];
        current.forEach((l, i) => {
          const p = plans[i];
          if (p.status === "resize" && !stalled.has(l.id) && (used.get(l.id) ?? 0) < passCap(l, maxPasses)) {
            items.push({ id: l.id, name: l.name, factor: p.factor, from: p.from, to: p.to, expect_size: p.from });
          }
        });
        if (items.length === 0) break;
        const run = () =>
          runGuardedWrite(ctx, {
            toolName: "ae_fit_text",
            label: `ae_fit_text(pass ${pass}, ${items.length} layer${items.length === 1 ? "" : "s"})`,
            expect: args.expect,
            compId: args.comp_id,
            read: () => ({ host: "fittextMeasure", args: readArgs(items) }),
            write: {
              host: "fittextApply",
              args: {
                comp_id: args.comp_id,
                time: first.time,
                scale_leading: scaleLeading,
                items: items.map((it) => ({ layer: { id: it.id }, factor: it.factor, expect_size: it.expect_size })),
                label: "Fit text",
              },
            },
            check: (before, after) => fitMismatches(items, scaleLeading, before, after),
            present: (_b, after, w) => ({ measured: after, changes: w.layers }),
          });
        let out: Awaited<ReturnType<typeof run>>;
        if (pass === 1) {
          // Nothing is written yet: a refusal here is an ordinary error.
          out = await run();
        } else {
          // An earlier pass is in the project. Its op_id, checkpoint and receipt must reach the caller, so a failure here ends the loop and is reported.
          try {
            out = await run();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            passError = { pass, message };
            passes.push({
              pass,
              error: message,
              note: `Pass ${pass} did not complete. The earlier passes are applied and kept; measure again before trying more.`,
            });
            break;
          }
        }
        const before = current;
        for (const it of items) used.set(it.id, (used.get(it.id) ?? 0) + 1);
        passes.push({ pass, op_id: out.op_id, checkpoint: out.checkpoint, changes: (out as Record<string, unknown>).changes, receipt: out.receipt });
        const measured = (out as Record<string, unknown>).measured as MeasureResult | null | undefined;
        if (!measured) break;
        // Fold the new measurements into the current list and plan again.
        current = current.map((l) => measured.layers.find((n) => n.id === l.id) ?? l);
        for (const it of items) {
          const was = before.find((l) => l.id === it.id);
          const now = current.find((l) => l.id === it.id);
          if (!was || !now) continue;
          const same = (a: number, b: number) => Math.abs(a - b) <= Math.abs(a) * 0.005 + 0.01;
          // A box whose overflow is still on is judged by that flag, not by its bounds (box text keeps its box's size).
          if (same(was.bounds.width, now.bounds.width) && same(was.bounds.height, now.bounds.height) && now.boxOverflow !== true) stalled.add(it.id);
        }
        plans = current.map((l) => planFit(l, opts));
        // A write that did not read back as written is not built on further.
        if (!out.receipt.matches) break;
      }

      const final: FinalStatus[] = current.map((l, i) => {
        const p = plans[i];
        const n = used.get(l.id) ?? 0;
        let status: FinalStatus["status"];
        let reason: string | undefined;
        if (p.status === "resize") {
          status = "unfitted";
          if (stalled.has(l.id)) reason = "the text's bounds did not change with the font size; more passes would not help";
          else if (passError && n < passCap(l, maxPasses)) reason = `pass ${passError.pass} failed: ${passError.message}`;
          else reason = n >= passCap(l, maxPasses) ? `still outside the region after ${n} pass${n === 1 ? "" : "es"}` : "not written";
        } else {
          status = p.status;
          reason = p.status === "fits" ? undefined : p.reason;
        }
        return { id: l.id, name: l.name, status, reason, from_size: startSize.get(l.id), to_size: l.fontSize, passes: n, bounds: l.bounds, overflow: l.boxOverflow };
      });
      const lastWithReceipt = [...passes].reverse().find((p) => p.receipt !== undefined);
      return {
        ok: true,
        applied: passes.some((p) => p.op_id !== undefined),
        region,
        passes,
        layers: final,
        receipt: lastWithReceipt?.receipt,
        all_fit: !passError && final.every((f) => f.status === "fits"),
        ...(passError ? { pass_error: passError } : {}),
        skipped: first.skipped,
      };
    },
  },
  {
    name: "ae_text_backdrop",
    description:
      "Put a rectangle behind a text layer that is always the text's size plus padding: a shape layer directly below it whose Rectangle Size and Position are expressions on the text's sourceRectAtTime, so it follows edits to the text. " +
      "One undo group guarded by `expect`; the read-back (a separate evalScript) checks the box sits directly below the text, its expression has no error and its evaluated size is the text's bounds plus padding. " +
      "The expression finds the text layer by name, so renaming the text layer by script breaks it. The box is the bounding box of the text's bounds in comp space, so Scale, rotation and a parent are followed; the receipt checks the size only for an unrotated, unparented, 2D text layer (it takes Scale into account). " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeTextBackdropSchema,
    handler: async (args: BackdropArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_text_backdrop",
        label: "ae_text_backdrop",
        expect: args.expect,
        compId: args.comp_id,
        read: (phase, w) => ({
          host: "fittextBackdropRead",
          args: { comp_id: args.comp_id, layer: args.layer, backdrop_id: phase === "after" ? (w?.backdrop as { id?: number } | undefined)?.id : undefined },
        }),
        write: {
          host: "fittextBackdrop",
          args: {
            comp_id: args.comp_id,
            layer: args.layer,
            padding: args.padding ?? [24, 12],
            color: args.color ?? [0, 0, 0],
            opacity: args.opacity ?? 100,
            corner_radius: args.corner_radius ?? 0,
            name: args.name,
            label: "Text backdrop",
          },
        },
        check: (_before, after) => backdropMismatches(args, after),
        present: (_before, after, w) => ({ backdrop: (after as BackdropRead | null)?.backdrop ?? w.backdrop, text: (after as BackdropRead | null)?.text }),
      }),
  },
];
