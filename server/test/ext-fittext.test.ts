import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeSetTextSchema, animateTools, coveredByFirstRange, rangeActuals, rangeExpectations, resolvedRanges, TextRangeSchema } from "../src/tools/ext/animate.js";
import {
  AeFitTextSchema,
  AeMeasureTextSchema,
  AeTextBackdropSchema,
  backdropMismatches,
  fitMismatches,
  fitsRegion,
  fittextTools,
  liveExpressionText,
  liveMismatches,
  passCap,
  planFit,
  regionFor,
  regionOf,
  type MeasureResult,
  type TextMeasure,
} from "../src/tools/ext/fittext.js";
import { FakeComp, FakeLayer, FakeProject, FakeProperty, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => fittextTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fittext-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const bounds = (width: number, height: number) => ({ left: 0, top: -height * 0.8, width, height });

const M = (over: Partial<TextMeasure> = {}): TextMeasure => ({
  id: 5,
  index: 1,
  name: "Title",
  text_length: 11,
  numKeys: 0,
  expression: false,
  fontSize: 100,
  leading: 0,
  justification: "left",
  boxText: false,
  bounds: bounds(550, 120),
  ...over,
});

const measured = (layers: TextMeasure[]): MeasureResult => ({
  comp_id: 1,
  comp: { width: 640, height: 360 },
  time: 0,
  ranges_supported: true,
  layers,
});

const OPTS = { region: { maxW: 400 }, minSize: 6, maxSize: 1296, allowGrow: false };

describe("fit text: schemas", () => {
  it("ae_fit_text needs a region, takes one kind of region, and checks min and max size", () => {
    const base = { comp_id: 1, expect: expectArg };
    expect(AeFitTextSchema.safeParse(base).success).toBe(false);
    expect(AeFitTextSchema.safeParse({ ...base, max_width: 400 }).success).toBe(true);
    expect(AeFitTextSchema.safeParse({ ...base, safe_area: "title" }).success).toBe(true);
    expect(AeFitTextSchema.safeParse({ ...base, safe_area: "title", max_width: 400 }).success).toBe(false);
    expect(AeFitTextSchema.safeParse({ ...base, max_width: 400, min_size: 50, max_size: 20 }).success).toBe(false);
    expect(AeFitTextSchema.safeParse({ ...base, max_width: 400, max_passes: 9 }).success).toBe(false);
    // Removing a live fit needs no region.
    expect(AeFitTextSchema.safeParse({ ...base, mode: "unlive" }).success).toBe(true);
    expect(AeFitTextSchema.safeParse({ ...base, mode: "live", max_width: 400 }).success).toBe(true);
  });

  it("ae_fit_text and ae_text_backdrop are guarded writes; ae_measure_text is not", () => {
    expect(AeFitTextSchema.safeParse({ comp_id: 1, max_width: 400 }).success).toBe(false);
    expect(AeTextBackdropSchema.safeParse({ comp_id: 1, layer: { name: "T" } }).success).toBe(false);
    expect(AeTextBackdropSchema.safeParse({ comp_id: 1, layer: { name: "T" }, padding: [10], expect: expectArg }).success).toBe(false);
    expect(AeTextBackdropSchema.safeParse({ comp_id: 1, layer: { name: "T" }, padding: [10, 4], expect: expectArg }).success).toBe(true);
    expect(AeMeasureTextSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(AeMeasureTextSchema.safeParse({ comp_id: 1, safe_area: "action", max_height: 3 }).success).toBe(false);
    for (const name of ["ae_fit_text", "ae_text_backdrop"]) expect(tool(name).description).toContain("Always re-read project/comp state");
    expect(tool("ae_measure_text").description).not.toContain("Always re-read project/comp state");
  });

  it("ae_set_text ranges: match or start/end, a style, AE 24.3+", () => {
    const style = { fauxBold: true, fillColor: [1, 0, 0] };
    expect(TextRangeSchema.safeParse({ match: "NOW", style }).success).toBe(true);
    expect(TextRangeSchema.safeParse({ start: 0, end: 3, style }).success).toBe(true);
    expect(TextRangeSchema.safeParse({ start: 0, style }).success).toBe(true);
    expect(TextRangeSchema.safeParse({ match: "NOW", start: 0, style }).success).toBe(false);
    expect(TextRangeSchema.safeParse({ style }).success).toBe(false);
    expect(TextRangeSchema.safeParse({ end: 3, match: "x", style }).success).toBe(false);
    expect(TextRangeSchema.safeParse({ start: 3, end: 3, style }).success).toBe(false);
    expect(TextRangeSchema.safeParse({ match: "NOW", style: {} }).success).toBe(false);
    expect(TextRangeSchema.safeParse({ start: 0, end: 2, occurrence: "first", style }).success).toBe(false);
    const base = { comp_id: 1, layer: { name: "T" }, expect: expectArg };
    expect(AeSetTextSchema.safeParse({ ...base }).success).toBe(false);
    expect(AeSetTextSchema.safeParse({ ...base, ranges: [{ match: "NOW", style }] }).success).toBe(true);
  });
});

describe("fit text: pure logic", () => {
  it("regionOf turns the safe areas into 80% and 90% of the comp", () => {
    expect(regionOf({ safe_area: "title" }, { width: 1920, height: 1080 })).toEqual({ maxW: 1536, maxH: 864, onScreen: true });
    expect(regionOf({ safe_area: "action" }, { width: 1000, height: 500 })).toEqual({ maxW: 900, maxH: 450, onScreen: true });
    expect(regionOf({ max_width: 300 }, { width: 1920, height: 1080 })).toEqual({ maxW: 300, maxH: undefined });
  });

  it("fitsRegion allows half a percent of rounding", () => {
    expect(fitsRegion(bounds(401, 50), { maxW: 400 })).toBe(true);
    expect(fitsRegion(bounds(403, 50), { maxW: 400 })).toBe(false);
    expect(fitsRegion(bounds(100, 61), { maxW: 400, maxH: 60 })).toBe(false);
  });

  it("planFit shrinks point text by the ratio, a hair under, and leaves text that fits alone", () => {
    const p = planFit(M(), OPTS);
    expect(p.status).toBe("resize");
    if (p.status === "resize") {
      expect(p.from).toBe(100);
      expect(p.to).toBeLessThan(72.73);
      expect(p.to).toBeGreaterThan(72);
      expect(p.factor).toBeCloseTo(p.to / 100, 6);
    }
    expect(planFit(M({ bounds: bounds(300, 120) }), OPTS)).toEqual({ status: "fits" });
  });

  it("planFit uses the tighter of width and height", () => {
    const p = planFit(M(), { ...OPTS, region: { maxW: 400, maxH: 60 } });
    expect(p.status === "resize" && p.to).toBeLessThan(50);
  });

  it("planFit grows only on request, and never box text", () => {
    const small = M({ bounds: bounds(200, 60) });
    expect(planFit(small, OPTS)).toEqual({ status: "fits" });
    const grown = planFit(small, { ...OPTS, allowGrow: true });
    expect(grown.status === "resize" && grown.to).toBeGreaterThan(190);
    expect(planFit(small, { ...OPTS, allowGrow: true, maxSize: 150 }).status === "resize" && (planFit(small, { ...OPTS, allowGrow: true, maxSize: 150 }) as { to: number }).to).toBe(150);
    expect(planFit(M({ bounds: bounds(200, 60), boxText: true }), { ...OPTS, allowGrow: true })).toEqual({ status: "fits" });
  });

  it("planFit stops at the minimum size and reports it", () => {
    const p = planFit(M({ fontSize: 8, bounds: bounds(550, 10) }), { ...OPTS, minSize: 8 });
    expect(p).toMatchObject({ status: "limit" });
    const q = planFit(M({ fontSize: 20, bounds: bounds(550, 30) }), { ...OPTS, minSize: 18 });
    expect(q.status === "resize" && q.to).toBe(18);
  });

  it("planFit takes a 5% step on an overflowing box even when its bounds fit", () => {
    const box = M({ boxText: true, boxOverflow: true, bounds: bounds(300, 90) });
    const p = planFit(box, { ...OPTS, region: { maxH: 100 } });
    expect(p.status === "resize" && p.to).toBeLessThan(95);
    expect(planFit({ ...box, boxOverflow: false }, { ...OPTS, region: { maxH: 100 } })).toEqual({ status: "fits" });
  });

  it("planFit skips keyed text, text with an expression, empty text and unreadable sizes", () => {
    expect(planFit(M({ numKeys: 2 }), OPTS)).toMatchObject({ status: "skip", reason: expect.stringContaining("keyed") });
    expect(planFit(M({ expression: true }), OPTS)).toMatchObject({ status: "skip", reason: expect.stringContaining("expression") });
    expect(planFit(M({ bounds: bounds(0, 0) }), OPTS)).toMatchObject({ status: "skip" });
    expect(planFit(M({ fontSize: undefined }), OPTS)).toMatchObject({ status: "skip" });
  });

  it("passCap gives point text one correction and box text the caller's cap", () => {
    expect(passCap(M(), 4)).toBe(2);
    expect(passCap(M(), 1)).toBe(1);
    expect(passCap(M({ boxText: true }), 4)).toBe(4);
  });

  it("planFit does not keep shrinking box text whose box is wider than the region", () => {
    // 500-wide box, region 300: the measured width stays near the box width at any size.
    const wide = M({ boxText: true, boxTextSize: [500, 100], bounds: bounds(490, 60) });
    const p = planFit(wide, { ...OPTS, region: { maxW: 300 } });
    expect(p).toMatchObject({ status: "limit", reason: expect.stringContaining("resize the box") });
    const tall = M({ boxText: true, boxTextSize: [200, 400], boxOverflow: true, bounds: bounds(200, 400) });
    expect(planFit(tall, { ...OPTS, region: { maxH: 300 } })).toMatchObject({ status: "limit", reason: expect.stringContaining("taller") });
    // A box inside the region steps only on overflow, never by the width ratio.
    const ok = M({ boxText: true, boxTextSize: [250, 100], boxOverflow: true, bounds: bounds(250, 100) });
    const q = planFit(ok, { ...OPTS, region: { maxW: 300, maxH: 100 } });
    expect(q.status === "resize" && q.to).toBeGreaterThan(94);
    // And text that fits is left alone even when its box is wider than the region.
    expect(planFit(M({ boxText: true, boxTextSize: [500, 100], bounds: bounds(250, 60) }), { ...OPTS, region: { maxW: 300 } })).toEqual({ status: "fits" });
  });

  it("planFit skips a locked layer", () => {
    expect(planFit(M({ locked: true }), OPTS)).toMatchObject({ status: "skip", reason: expect.stringContaining("locked") });
  });

  it("fitMismatches leaves leading alone on auto leading", () => {
    const items = [{ id: 5, name: "Title", factor: 0.5, from: 100, to: 50, expect_size: 100 }];
    const before = measured([M({ leading: 80, autoLeading: true })]);
    expect(fitMismatches(items, true, before, measured([M({ fontSize: 50, leading: 80 })]))).toEqual([]);
  });

  it("backdropMismatches counts Scale and leaves rotated or parented text unchecked", () => {
    const args = AeTextBackdropSchema.parse({ comp_id: 1, layer: { name: "Title" }, padding: [10, 5], expect: expectArg });
    const read = (text: object, size: number[]) => ({
      text: { id: 5, index: 2, name: "Title", bounds: bounds(300, 100), ...text },
      backdrop: { id: 9, index: 3, name: "Title Box", kind: "shape", size, expression_error: null },
    });
    // Scale 200% x 50%: 600 + 20, 50 + 10.
    expect(backdropMismatches(args, read({ scale: [200, 50] }, [620, 60]))).toEqual([]);
    expect(backdropMismatches(args, read({ scale: [200, 50] }, [320, 110]))[0].path).toBe("backdrop.size");
    expect(backdropMismatches(args, read({ rotation: 30 }, [999, 999]))).toEqual([]);
    expect(backdropMismatches(args, read({ parented: true }, [999, 999]))).toEqual([]);
    expect(backdropMismatches(args, read({ three_d: true }, [999, 999]))).toEqual([]);
  });

  it("fitMismatches checks size, text length, justification and scaled leading", () => {
    const items = [{ id: 5, name: "Title", factor: 0.5, from: 100, to: 50, expect_size: 100 }];
    const before = measured([M({ leading: 80 })]);
    const good = measured([M({ fontSize: 50, leading: 40 })]);
    expect(fitMismatches(items, true, before, good)).toEqual([]);
    expect(fitMismatches(items, true, before, measured([M({ fontSize: 60, leading: 40 })]))).toHaveLength(1);
    expect(fitMismatches(items, true, before, measured([M({ fontSize: 50, leading: 80 })]))[0].path).toContain("leading");
    expect(fitMismatches(items, false, before, measured([M({ fontSize: 50, leading: 80 })]))).toEqual([]);
    expect(fitMismatches(items, true, before, measured([M({ fontSize: 50, leading: 40, justification: "center" })]))[0].path).toContain("justification");
    expect(fitMismatches(items, true, before, measured([M({ fontSize: 50, leading: 40, text_length: 3 })]))[0].path).toContain("text_length");
    expect(fitMismatches(items, true, before, measured([]))[0].message).toContain("not in the read-back");
  });

  it("liveMismatches and backdropMismatches", () => {
    const on = measured([M({ live_fit: { installed: true, error: null } })]);
    expect(liveMismatches(false, on, [5])).toEqual([]);
    expect(liveMismatches(true, on, [5])).toHaveLength(1);
    const offOurs = measured([M({ live_fit: { installed: false, ours: true, enabled: false, error: null } })]);
    expect(liveMismatches(false, offOurs, [5])).toHaveLength(1);
    expect(liveMismatches(true, offOurs, [5])).toHaveLength(1);
    expect(liveMismatches(false, measured([M({ live_fit: { installed: true, error: "bad" } })]), [5])[0].path).toContain("error");
    const args = AeTextBackdropSchema.parse({ comp_id: 1, layer: { name: "Title" }, padding: [10, 5], expect: expectArg });
    const read = (over: object) => ({
      text: { id: 5, index: 2, name: "Title", bounds: bounds(300, 100) },
      backdrop: { id: 9, index: 3, name: "Title Box", kind: "shape", size: [320, 110], expression_error: null, ...over },
    });
    expect(backdropMismatches(args, read({}))).toEqual([]);
    expect(backdropMismatches(args, read({ index: 1 }))[0].path).toBe("backdrop.index");
    const named = (name_set: boolean) => ({ ...read({}), text: { id: 5, index: 2, name: "Title", bounds: bounds(300, 100), name_set } });
    expect(backdropMismatches(args, named(true))).toEqual([]);
    expect(backdropMismatches(args, named(false))[0].path).toBe("text.name_set");
    expect(backdropMismatches(args, read({ size: [300, 100] }))[0].path).toBe("backdrop.size");
    expect(backdropMismatches(args, read({ expression_error: "x" }))[0].path).toBe("backdrop.expression_error");
    expect(backdropMismatches(args, { text: read({}).text })[0].path).toBe("backdrop");
  });

  it("range helpers pair what was asked with what was read, mixed staying undefined", () => {
    const applied = resolvedRanges({ ranges: [{ start: 6, end: 9, style: { fauxBold: true, fontSize: 40 } }, { nope: 1 }] });
    expect(applied).toHaveLength(1);
    expect(rangeExpectations(applied)).toEqual({ "ranges[0].fauxBold": true, "ranges[0].fontSize": 40 });
    expect(rangeActuals(applied, [{ style: { fauxBold: true } }])).toEqual({ "ranges[0].fauxBold": true, "ranges[0].fontSize": undefined });
    expect(resolvedRanges(undefined)).toEqual([]);
  });
});

describe("fit text: tool flows with a fake bridge", () => {
  const fitArgs = (extra: object = {}) => AeFitTextSchema.parse({ comp_id: 1, max_width: 400, expect: expectArg, ...extra });

  it("ae_fit_text measures, guards, reads, writes, and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      fittextMeasure: [
        measured([M()]),
        measured([M()]),
        measured([M({ fontSize: 72.58, bounds: bounds(399, 87) })]),
      ],
      fittextApply: [{ comp_id: 1, layers: [{ id: 5, name: "Title", from_size: 100, to_size: 72.58 }] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure", "checkGuard", "fittextMeasure", "fittextApply", "fittextMeasure"]);
    expect(calls[3].script).toContain('"expect"');
    expect(calls[3].script).toContain('"expect_size":100');
    expect(out.passes).toHaveLength(1);
    expect(out.receipt.matches).toBe(true);
    expect(out.all_fit).toBe(true);
    expect(out.layers[0]).toMatchObject({ name: "Title", status: "fits", from_size: 100, to_size: 72.58, passes: 1 });
  });

  it("ae_fit_text folds a layer the host left out into status skip and does not retry it", async () => {
    const { ctx, calls } = fakeAe({
      fittextMeasure: [measured([M()]), measured([M()]), measured([M()])],
      fittextApply: [{ comp_id: 1, layers: [], skipped: [{ id: 5, name: "Title", reason: "its sizes could not be read character by character" }], no_op: true }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(calls.filter((c) => c.fn === "fittextApply")).toHaveLength(1);
    expect(out.receipt.matches).toBe(true);
    expect(out.layers[0]).toMatchObject({ name: "Title", status: "skip", reason: expect.stringContaining("character by character") });
    expect(out.all_fit).toBe(false);
    // Nothing was written, so nothing is reported as applied.
    expect(out.applied).toBe(false);
    expect(out.passes[0].wrote_nothing).toBe(true);
  });

  it("planFit skips text over the scan limit, and ae_fit_text still fits the short title", async () => {
    expect(planFit(M({ text_length: 2100 }), OPTS)).toMatchObject({ status: "skip", reason: expect.stringContaining("over 2000 characters") });
    expect(planFit(M({ text_length: 2000 }), OPTS).status).not.toBe("skip");
    // One trailing line break is not scanned: 2001 characters ending in one are 2000 to scan.
    expect(planFit(M({ text_length: 2001, range_length: 2000 }), OPTS).status).not.toBe("skip");
    // Without character ranges the host never refuses, so the server does not either.
    expect(planFit(M({ text_length: 2100 }), { ...OPTS, rangesSupported: false }).status).not.toBe("skip");
    const long = M({ id: 6, name: "Long", text_length: 2100 });
    const { ctx } = fakeAe({
      fittextMeasure: [measured([M(), long]), measured([M(), long]), measured([M({ fontSize: 72.58, bounds: bounds(399, 87) }), long])],
      fittextApply: [{ comp_id: 1, layers: [{ id: 5, name: "Title", from_size: 100, to_size: 72.58 }] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(out.layers.find((l: any) => l.name === "Title")).toMatchObject({ status: "fits", to_size: 72.58 });
    expect(out.layers.find((l: any) => l.name === "Long")).toMatchObject({ status: "skip", reason: expect.stringContaining("over 2000 characters") });
  });

  it("writes one correction when point text is not quite linear, then stops", async () => {
    const { ctx, calls } = fakeAe({
      fittextMeasure: [
        measured([M()]),
        measured([M()]),
        measured([M({ fontSize: 72.58, bounds: bounds(420, 90) })]),
        measured([M({ fontSize: 72.58, bounds: bounds(420, 90) })]),
        measured([M({ fontSize: 69, bounds: bounds(412, 86) })]),
      ],
      fittextApply: [{ layers: [] }, { layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ max_passes: 4 }), ctx);
    expect(calls.filter((c) => c.fn === "fittextApply")).toHaveLength(2);
    expect(out.passes).toHaveLength(2);
    // The second pass's size came from the first pass's measurement.
    expect(out.layers[0]).toMatchObject({ status: "unfitted", passes: 2 });
    expect(out.layers[0].reason).toContain("2 passes");
    expect(out.all_fit).toBe(false);
  });

  it("steps box text down until the box stops overflowing", async () => {
    const box = (over: Partial<TextMeasure>) => M({ boxText: true, boxTextSize: [300, 100], ...over });
    const { ctx, calls } = fakeAe({
      fittextMeasure: [
        measured([box({ boxOverflow: true, bounds: bounds(300, 100) })]),
        measured([box({ boxOverflow: true, bounds: bounds(300, 100) })]),
        measured([box({ fontSize: 94.8, boxOverflow: true, bounds: bounds(300, 100) })]),
        measured([box({ fontSize: 94.8, boxOverflow: true, bounds: bounds(300, 100) })]),
        measured([box({ fontSize: 89.88, boxOverflow: false, bounds: bounds(290, 96) })]),
      ],
      fittextApply: [{ layers: [] }, { layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ max_width: undefined, max_height: 100 }), ctx);
    expect(calls.filter((c) => c.fn === "fittextApply")).toHaveLength(2);
    expect(out.layers[0]).toMatchObject({ status: "fits", passes: 2, overflow: false });
    expect(out.all_fit).toBe(true);
  });

  it("dry_run plans without a guard or a write", async () => {
    const { ctx, calls } = fakeAe({ fittextMeasure: [measured([M(), M({ id: 6, name: "Sub", bounds: bounds(100, 20) })])] });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ dry_run: true }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure"]);
    expect(out.dry_run).toBe(true);
    expect(out.layers.map((l: any) => l.plan.status)).toEqual(["resize", "fits"]);
  });

  it("makes no write when everything fits or is skipped, and says why", async () => {
    const { ctx, calls } = fakeAe({ fittextMeasure: [measured([M({ bounds: bounds(100, 20) }), M({ id: 6, name: "Keyed", numKeys: 3 })])] });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure"]);
    expect(out.applied).toBe(false);
    expect(out.layers.map((l: any) => l.status)).toEqual(["fits", "skip"]);
    expect(out.layers[1].reason).toContain("keyed");
    expect(out.all_fit).toBe(false);
  });

  it("puts a wrong read-back into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      fittextMeasure: [measured([M()]), measured([M()]), measured([M({ fontSize: 90, bounds: bounds(399, 87) })])],
      fittextApply: [{ layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(out.passes[0].receipt.matches).toBe(false);
    expect(out.passes[0].receipt.mismatches[0].path).toContain("fontSize");
  });

  it("a failed after-read stops the loop with the write reported applied", async () => {
    const { ctx } = fakeAe({
      fittextMeasure: [measured([M()]), measured([M()])],
      fittextApply: [{ layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(out.applied).toBe(true);
    expect(out.passes).toHaveLength(1);
    expect(out.passes[0].receipt.matches).toBe(false);
    expect(JSON.stringify(out.passes[0].receipt.mismatches)).toContain("Do not resend");
  });

  it("reports an empty selection without touching AE further", async () => {
    const { ctx, calls } = fakeAe({ fittextMeasure: [measured([])] });
    const out: any = await tool("ae_fit_text").handler(fitArgs(), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toHaveLength(1);
  });

  it("live mode installs the expression with the region and checks it in the read-back", async () => {
    const live = (installed: boolean, error: string | null = null) => measured([M({ live_fit: { installed, error } })]);
    const { ctx, calls } = fakeAe({
      fittextMeasure: [live(false), live(false), live(true)],
      fittextLive: [{ comp_id: 1, layers: [{ id: 5, name: "Title", expression: true }] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ mode: "live", safe_area: "title", max_width: undefined }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure", "checkGuard", "fittextMeasure", "fittextLive", "fittextMeasure"]);
    expect(calls[3].script).toContain('"max_width":512');
    expect(out.receipt.matches).toBe(true);
    expect(out.mode).toBe("live");
  });

  it("unlive reports an expression that is still there", async () => {
    const live = (installed: boolean) => measured([M({ live_fit: { installed, error: null } })]);
    const { ctx } = fakeAe({
      fittextMeasure: [live(true), live(true), live(true)],
      fittextLive: [{ layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(AeFitTextSchema.parse({ comp_id: 1, mode: "unlive", expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
  });

  it("live and unlive dry_run write nothing: no guard, no fittextLive call", async () => {
    const live = (installed: boolean, extra: object = {}) => M({ live_fit: { installed, error: null }, ...extra });
    for (const mode of ["live", "unlive"] as const) {
      const { ctx, calls } = fakeAe({
        fittextMeasure: [measured([live(mode === "unlive"), live(false, { id: 6, name: "Locked", locked: true }), live(false, { id: 7, name: "Other", live_fit: { installed: false, error: null, foreign: true } })])],
      });
      const out: any = await tool("ae_fit_text").handler(fitArgs({ mode, dry_run: true }), ctx);
      expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure"]);
      expect(out).toMatchObject({ ok: true, dry_run: true, mode });
      expect(out.would.map((w: any) => w.action)).toEqual([mode === "live" ? "install" : "remove"]);
      if (mode === "live") {
        expect(out.expression).toBe(liveExpressionText(400, undefined));
        expect(out.skipped.map((s: any) => s.reason).join("|")).toContain("locked");
        expect(out.skipped.map((s: any) => s.reason).join("|")).toContain("not this tool's");
      }
    }
  });

  it("live mode sends only layers it can change, and writes nothing when none are left", async () => {
    const lockedOnly = fakeAe({ fittextMeasure: [measured([M({ locked: true })])] });
    const none: any = await tool("ae_fit_text").handler(fitArgs({ mode: "live" }), lockedOnly.ctx);
    expect(lockedOnly.calls.map((c) => c.fn)).toEqual(["fittextMeasure"]);
    expect(none).toMatchObject({ ok: true, applied: false });
    expect(none.skipped[0].reason).toContain("locked");

    const live = (installed: boolean) => measured([M({ live_fit: { installed, error: null } }), M({ id: 6, name: "Locked", locked: true })]);
    const { ctx, calls } = fakeAe({ fittextMeasure: [live(false), live(false), measured([M({ live_fit: { installed: true, error: null } })])], fittextLive: [{ layers: [] }] });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ mode: "live" }), ctx);
    expect(calls.find((c) => c.fn === "fittextLive")!.script).toContain('"layers":[{"id":5}]');
    expect(out.receipt.matches).toBe(true);
    expect(out.skipped).toHaveLength(1);
  });

  it("a later pass that throws keeps the earlier pass's op_id, checkpoint and receipt", async () => {
    // fittextApply answers once; the second call finds no scripted answer and throws.
    const { ctx, calls } = fakeAe({
      fittextMeasure: [
        measured([M()]),
        measured([M()]),
        measured([M({ fontSize: 72.58, bounds: bounds(420, 90) })]),
        measured([M({ fontSize: 72.58, bounds: bounds(420, 90) })]),
      ],
      fittextApply: [{ layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ max_passes: 4 }), ctx);
    expect(calls.filter((c) => c.fn === "fittextApply")).toHaveLength(2);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.passes).toHaveLength(2);
    expect(out.passes[0].op_id).toBeTruthy();
    expect(out.passes[0].receipt).toBeDefined();
    expect(out.passes[1]).toMatchObject({ pass: 2, error: expect.any(String) });
    expect(out.pass_error).toMatchObject({ pass: 2 });
    expect(out.receipt).toBe(out.passes[0].receipt);
    expect(out.all_fit).toBe(false);
    expect(out.layers[0].status).toBe("unfitted");
    expect(out.layers[0].reason).toContain("pass 2 failed");
  });

  it("the first pass still throws, since nothing was written", async () => {
    const { ctx } = fakeAe({ fittextMeasure: [measured([M()]), measured([M()])] });
    await expect(tool("ae_fit_text").handler(fitArgs(), ctx)).rejects.toThrow();
  });

  it("does not shrink box text wider than the region, and writes nothing", async () => {
    const { ctx, calls } = fakeAe({ fittextMeasure: [measured([M({ boxText: true, boxTextSize: [500, 100], boxOverflow: true, bounds: bounds(490, 60) })])] });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ max_width: 300 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure"]);
    expect(out.applied).toBe(false);
    expect(out.layers[0]).toMatchObject({ status: "limit" });
    expect(out.layers[0].reason).toContain("resize the box");
  });

  it("stops a layer whose bounds did not move with the size", async () => {
    const same = { fontSize: 72.58, bounds: bounds(550, 120) };
    const { ctx, calls } = fakeAe({
      fittextMeasure: [measured([M()]), measured([M()]), measured([M(same)])],
      fittextApply: [{ layers: [] }, { layers: [] }],
    });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ max_passes: 4 }), ctx);
    expect(calls.filter((c) => c.fn === "fittextApply")).toHaveLength(1);
    expect(out.layers[0]).toMatchObject({ status: "unfitted" });
    expect(out.layers[0].reason).toContain("did not change");
  });

  it("names the non-text layers that were selected and skipped", async () => {
    const { ctx } = fakeAe({ fittextMeasure: [{ ...measured([]), skipped: [{ id: 3, name: "BG", reason: "not a text layer" }] }] });
    const out: any = await tool("ae_fit_text").handler(fitArgs({ layers: [{ name: "BG" }] }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(out.message).toContain("BG");
  });

  it("ae_measure_text reads once and says which layers fit", async () => {
    const { ctx, calls } = fakeAe({ fittextMeasure: [measured([M(), M({ id: 6, name: "Sub", bounds: bounds(100, 20) })])] });
    const out: any = await tool("ae_measure_text").handler(AeMeasureTextSchema.parse({ comp_id: 1, max_width: 400 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["fittextMeasure"]);
    expect(out.layers.map((l: any) => l.fits)).toEqual([false, true]);
    const none: any = await tool("ae_measure_text").handler(AeMeasureTextSchema.parse({ comp_id: 1 }), fakeAe({ fittextMeasure: [measured([M()])] }).ctx);
    expect(none.layers[0].fits).toBeUndefined();
  });

  it("ae_text_backdrop reads the text, writes, and reads the box back", async () => {
    const text = { id: 5, index: 2, name: "Title", bounds: bounds(300, 100) };
    const { ctx, calls } = fakeAe({
      fittextBackdropRead: [{ text }, { text, backdrop: { id: 9, index: 3, name: "Title Box", kind: "shape", size: [348, 124], expression_error: null } }],
      fittextBackdrop: [{ comp_id: 1, text: { id: 5, name: "Title" }, backdrop: { id: 9, index: 3, name: "Title Box" } }],
    });
    const out: any = await tool("ae_text_backdrop").handler(AeTextBackdropSchema.parse({ comp_id: 1, layer: { name: "Title" }, expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "fittextBackdropRead", "fittextBackdrop", "fittextBackdropRead"]);
    expect(calls[3].script).toContain('"backdrop_id":9');
    expect(calls[2].script).toContain('"padding":[24,12]');
    expect(out.receipt.matches).toBe(true);
    expect(out.backdrop).toMatchObject({ id: 9, kind: "shape" });
  });

  it("ae_set_text ranges: the write carries them and each is read back by offsets", async () => {
    const setText = animateTools.find((t) => t.name === "ae_set_text")!;
    const doc = { text: "GO NOW", font: "ArialMT", fontSize: 72, applyFill: true, fillColor: [1, 1, 1], justification: "left" };
    const { ctx, calls } = fakeAe({
      getTextDocument: [
        { document: doc },
        { document: doc, ranges: [{ start: 3, end: 6, text: "NOW", style: { fauxBold: true, fillColor: [1, 0, 0] }, mixed: [] }] },
      ],
      setText: [{ applied: ["ranges"], ranges: [{ start: 3, end: 6, text: "NOW", style: { fauxBold: true, fillColor: [1, 0, 0] } }] }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, ranges: [{ match: "NOW", style: { fauxBold: true, fillColor: [1, 0, 0] } }], expect: expectArg });
    const out: any = await setText.handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "getTextDocument", "setText", "getTextDocument"]);
    expect(calls[2].script).toContain('"match":"NOW"');
    expect(calls[3].script).toContain('"ranges":[{"start":3,"end":6}]');
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_set_text ranges: a field that reads back mixed is a mismatch", async () => {
    const setText = animateTools.find((t) => t.name === "ae_set_text")!;
    const doc = { text: "GO NOW", justification: "left" };
    const { ctx } = fakeAe({
      getTextDocument: [{ document: doc }, { document: doc, ranges: [{ start: 3, end: 6, text: "NOW", style: {}, mixed: ["fontSize"] }] }],
      setText: [{ ranges: [{ start: 3, end: 6, text: "NOW", style: { fontSize: 40 } }] }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, ranges: [{ start: 3, end: 6, style: { fontSize: 40 } }], expect: expectArg });
    const out: any = await setText.handler(args, ctx);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt.mismatches)).toContain("ranges[0].fontSize");
  });
});

// ---------- the host functions under node:vm ----------

const PJ = { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7414, RIGHT_JUSTIFY: 7415 };

interface CharStyle {
  font: string;
  fontSize: number;
  tracking: number;
  baselineShift: number;
  fillColor: number[];
  strokeColor: number[];
  strokeWidth: number;
  applyFill: boolean;
  applyStroke: boolean;
  fauxBold: boolean;
  fauxItalic: boolean;
}

const STYLE_KEYS: Array<keyof CharStyle> = ["font", "fontSize", "tracking", "baselineShift", "fillColor", "strokeColor", "strokeWidth", "applyFill", "applyStroke", "fauxBold", "fauxItalic"];

const baseStyle = (size: number): CharStyle => ({
  font: "ArialMT",
  fontSize: size,
  tracking: 0,
  baselineShift: 0,
  fillColor: [1, 1, 1],
  strokeColor: [0, 0, 0],
  strokeWidth: 0,
  applyFill: true,
  applyStroke: false,
  fauxBold: false,
  fauxItalic: false,
});

/** A range of a fake TextDocument: reads undefined when its characters differ, writes all of them. */
class FakeRange {
  constructor(private doc: FakeDoc, private start: number, private end: number) {}
  get text() {
    return this.doc.text.substring(this.start, this.end);
  }
}
for (const key of STYLE_KEYS) {
  Object.defineProperty(FakeRange.prototype, key, {
    get(this: any) {
      const vals = this.doc.chars.slice(this.start, this.end).map((c: CharStyle) => JSON.stringify(c[key]));
      return vals.every((v: string) => v === vals[0]) ? JSON.parse(vals[0]) : undefined;
    },
    set(this: any, v: unknown) {
      for (let i = this.start; i < this.end; i++) this.doc.chars[i][key] = Array.isArray(v) ? Array.from(v) : v;
      if (key === "fillColor") for (let i = this.start; i < this.end; i++) this.doc.chars[i].applyFill = true;
    },
  });
}

/** A TextDocument with per-character styling, AE's copy-on-read semantics and a crude text measure. */
class FakeDoc {
  chars: CharStyle[];
  leading = 0;
  autoLeading = false;
  justification = PJ.LEFT_JUSTIFY;
  boxText = false;
  boxTextSize: number[] = [0, 0];
  fontObject = { isSubstitute: false };
  tracking = 0;
  private value = "";
  constructor(text: string, size: number, public inclusiveEnd = false) {
    this.chars = Array.from(text, () => baseStyle(size));
    this.value = text;
  }
  get text() {
    return this.value;
  }
  /** New text takes the style of the first character, as AE does for a plain text write. */
  set text(v: string) {
    const first = this.chars[0] ?? baseStyle(100);
    this.chars = Array.from(v, (_c, i) => this.chars[i] ?? { ...first, fillColor: [...first.fillColor], strokeColor: [...first.strokeColor] });
    this.value = v;
  }
  get fontSize() {
    return this.chars[0].fontSize;
  }
  set fontSize(v: number) {
    for (const c of this.chars) c.fontSize = v;
  }
  characterRange(start: number, end: number) {
    const stop = this.inclusiveEnd ? end + 1 : end;
    if (start < 0 || stop <= start || stop > this.text.length) throw new Error("Invalid character range");
    return new FakeRange(this, start, stop);
  }
  clone() {
    const d = new FakeDoc(this.text, 1, this.inclusiveEnd);
    d.chars = this.chars.map((c) => ({ ...c, fillColor: [...c.fillColor], strokeColor: [...c.strokeColor] }));
    Object.assign(d, { leading: this.leading, autoLeading: this.autoLeading, justification: this.justification, boxText: this.boxText, boxTextSize: [...this.boxTextSize] });
    return d;
  }
  private lineHeight(from: number, to: number) {
    if (this.leading > 0) return this.leading;
    return 1.2 * Math.max(...this.chars.slice(from, to).map((c) => c.fontSize), 1);
  }
  /** Greedy word wrap at half the font size per character. */
  private lines(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let at = 0;
    for (const para of this.text.split(/\r|\n/)) {
      if (!this.boxText) {
        out.push([at, at + para.length]);
      } else {
        let lineStart = at;
        let width = 0;
        let pos = at;
        for (const word of para.split(/(?<= )/)) {
          const w = word.length === 0 ? 0 : this.chars.slice(pos, pos + word.length).reduce((s, c) => s + c.fontSize * 0.5, 0);
          if (width + w > this.boxTextSize[0] && pos > lineStart) {
            out.push([lineStart, pos]);
            lineStart = pos;
            width = 0;
          }
          width += w;
          pos += word.length;
        }
        out.push([lineStart, at + para.length]);
      }
      at += para.length + 1;
    }
    return out;
  }
  measure() {
    const lines = this.lines();
    let width = 0;
    let height = 0;
    for (const [a, b] of lines) {
      width = Math.max(width, this.chars.slice(a, b).reduce((s, c) => s + c.fontSize * 0.5, 0));
      height += this.lineHeight(a, b);
    }
    return { left: 0, top: -height * 0.8, width, height };
  }
  get boxOverflow() {
    return this.boxText && this.measure().height > this.boxTextSize[1];
  }
}

interface TextOpts {
  size?: number;
  leading?: number;
  box?: [number, number];
  inclusiveEnd?: boolean;
  /** AE's setValue drops justification the first time, as the known trap does. */
  dropsJustification?: boolean;
  noRanges?: boolean;
  /** The first read after a write returns the document as it was before it, as AE can within one script. */
  staleAfterWrite?: boolean;
  /** characterRange keeps answering from the stored text, ignoring text changed on the copy. */
  rangesIgnoreNewText?: boolean;
}

function textLayer(comp: FakeComp, name: string, text: string, o: TextOpts = {}): FakeLayer {
  const layer = comp.layers.addText(text) as FakeLayer;
  layer.name = name;
  const prop = (layer.property("ADBE Text Properties") as any).property("ADBE Text Document") as FakeProperty;
  let current = new FakeDoc(text, o.size ?? 100, o.inclusiveEnd);
  if (o.leading) current.leading = o.leading;
  if (o.box) Object.assign(current, { boxText: true, boxTextSize: o.box });
  const expose = (d: FakeDoc) => {
    const c = d.clone();
    if (o.noRanges) (c as any).characterRange = undefined;
    if (o.rangesIgnoreNewText) {
      const stored = current;
      (c as any).characterRange = (s: number, e: number) => stored.characterRange(s, e);
    }
    return c;
  };
  let dropped = false;
  let stale: FakeDoc | null = null;
  Object.defineProperty(prop, "value", {
    get: () => {
      if (stale) {
        const s = stale;
        stale = null;
        return expose(s);
      }
      return expose(current);
    },
    configurable: true,
  });
  (prop as any).valueAtTime = () => expose(current);
  prop.setValue = (v: unknown) => {
    if (o.staleAfterWrite) stale = current;
    current = (v as FakeDoc).clone();
    if (o.dropsJustification && !dropped) {
      dropped = true;
      current.justification = PJ.LEFT_JUSTIFY;
    }
  };
  layer.sourceRectAtTime = () => current.measure();
  (layer as any).doc = () => current;
  return layer;
}

const docOf = (l: FakeLayer): FakeDoc => (l as any).doc();

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const loaded = loadHost(project, ["fittext.jsx", "animate.jsx"]);
  loaded.G.ParagraphJustification = { ...PJ, FULL_JUSTIFY_LASTLINE_LEFT: 7416, FULL_JUSTIFY_LASTLINE_CENTER: 7417, FULL_JUSTIFY_LASTLINE_RIGHT: 7418, FULL_JUSTIFY_LASTLINE_FULL: 7419 };
  return { project, comp, ...loaded };
}

describe("fittext.jsx under the fake AE", () => {
  it("fittextMeasure reads bounds, sizes and box state and changes nothing", () => {
    const { comp, A, undo } = scene();
    comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1, 4);
    const title = textLayer(comp, "Title", "HELLO WORLD", { size: 100, leading: 80 });
    const box = textLayer(comp, "Para", "alpha beta gamma delta", { size: 20, box: [100, 40] });
    comp.time = 1.5;
    const res = A.fittextMeasure({ comp_id: comp.id });
    expect(res.layers.map((l: any) => l.name)).toEqual(["Para", "Title"]);
    const t = res.layers.find((l: any) => l.name === "Title");
    expect(t).toMatchObject({ id: title.id, fontSize: 100, leading: 80, boxText: false, text_length: 11, numKeys: 0, sizes_vary: false, justification: "left" });
    expect(t.bounds.width).toBe(550);
    const p = res.layers.find((l: any) => l.name === "Para");
    expect(p).toMatchObject({ id: box.id, boxText: true, boxOverflow: true });
    expect(p.boxTextSize).toEqual([100, 40]);
    expect(res.ranges_supported).toBe(true);
    expect(res.comp).toEqual({ width: 640, height: 360 });
    expect(res.time).toBe(1.5);
    expect(comp.time).toBe(1.5);
    expect(undo.begun).toBe(0);
    expect(A.fittextMeasure({ comp_id: comp.id, layers: [{ name: "Title" }], time: 2 }).time).toBe(2);
    const bgRes = A.fittextMeasure({ comp_id: comp.id, layers: [{ name: "BG" }, { name: "Title" }] });
    expect(bgRes.layers.map((l: any) => l.name)).toEqual(["Title"]);
    expect(bgRes.skipped).toEqual([{ id: expect.any(Number), name: "BG", reason: "not a text layer" }]);
  });

  it("fittextMeasure caps the per-character size scan and can skip it", () => {
    const { comp, A } = scene();
    // Three layers of 2000 characters against a 4000 budget: the top two are scanned in full, the last only probed.
    const a = textLayer(comp, "A", "x".repeat(2000), { size: 10 });
    textLayer(comp, "B", "y".repeat(2000), { size: 10 });
    textLayer(comp, "C", "z".repeat(2000), { size: 10 });
    docOf(a).chars[1999].fontSize = 30;
    const res = A.fittextMeasure({ comp_id: comp.id });
    expect(res.layers.map((l: any) => l.sizes_scan)).toEqual(["full", "full", "probe"]);
    expect(res.sizes_scan_capped).toBe(true);
    expect(res.layers[2]).toMatchObject({ name: "A", sizes_vary: true, min_run_size: 10, max_run_size: 30 });
    const none = A.fittextMeasure({ comp_id: comp.id, sizes: false });
    expect(none.layers.every((l: any) => l.sizes_vary === undefined && l.sizes_scan === undefined)).toBe(true);
  });

  it("fittextMeasure reports locked, auto leading and a foreign Scale expression", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "T", "HELLO", { size: 50 });
    t.locked = true;
    (docOf(t) as any).autoLeading = true;
    const scale = (t.property("ADBE Transform Group") as any).property("ADBE Scale") as FakeProperty;
    scale.expression = "wiggle(1, 5)";
    scale.expressionEnabled = true;
    const m = A.fittextMeasure({ comp_id: comp.id }).layers[0];
    expect(m.locked).toBe(true);
    expect(m.autoLeading).toBe(true);
    expect(m.live_fit).toMatchObject({ installed: false, foreign: true });
  });

  it("fittextMeasure reports per-range sizes and a build without ranges", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "Mixed", "ABCD", { size: 50 });
    docOf(l).chars[2].fontSize = 80;
    const m = A.fittextMeasure({ comp_id: comp.id }).layers[0];
    expect(m).toMatchObject({ sizes_vary: true, min_run_size: 50, max_run_size: 80 });
    const old = textLayer(comp, "Old", "xy", { noRanges: true });
    const res = A.fittextMeasure({ comp_id: comp.id, layers: [{ id: old.id }] });
    expect(res.ranges_supported).toBe(false);
    expect(res.layers[0].sizes_vary).toBeUndefined();
  });

  it("fittextApply scales a uniform text and a fixed leading in one undo group", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "Title", "HELLO WORLD", { size: 100, leading: 80 });
    const out = A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5, expect_size: 100 }], expect: GUARD });
    expect(docOf(t).fontSize).toBe(50);
    expect(docOf(t).leading).toBe(40);
    expect(out.layers[0]).toMatchObject({ mode: "uniform", from_size: 100, to_size: 50, leading_from: 80, leading_to: 40 });
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5 }], scale_leading: false, expect: GUARD });
    expect(docOf(t).fontSize).toBe(25);
    expect(docOf(t).leading).toBe(40);
  });

  it("fittextApply scales each run so per-range sizes keep their proportions", () => {
    for (const inclusiveEnd of [false, true]) {
      const { comp, A } = scene();
      const t = textLayer(comp, "Title", "HELLO NOW", { size: 100, inclusiveEnd });
      for (let i = 6; i < 9; i++) docOf(t).chars[i].fontSize = 200;
      const out = A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5 }], expect: GUARD });
      expect(out.layers[0]).toMatchObject({ mode: "runs", runs: 2 });
      expect(docOf(t).chars.map((c) => c.fontSize)).toEqual([50, 50, 50, 50, 50, 50, 100, 100, 100]);
    }
  });

  it("fittextApply clamps to AE's size limits and keeps justification", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "Title", "HI", { size: 1000, dropsJustification: true });
    docOf(t).justification = PJ.CENTER_JUSTIFY;
    const out = A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 10 }], expect: GUARD });
    expect(docOf(t).fontSize).toBe(1296);
    expect(docOf(t).justification).toBe(PJ.CENTER_JUSTIFY);
    expect(out.layers[0].justification_reasserted).toBe(true);
  });

  it("fittextApply validates before writing anything", () => {
    const { comp, A, undo } = scene();
    const a = textLayer(comp, "A", "one", { size: 100 });
    const b = textLayer(comp, "B", "two", { size: 100 });
    const solid = comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1, 4) as FakeLayer;
    const call = (items: unknown[], expect_ = GUARD) => A.fittextApply({ comp_id: comp.id, items, expect: expect_ });
    expect(() => call([{ layer: { id: a.id }, factor: 0.5 }, { layer: { id: b.id }, factor: -1 }])).toThrow(/factor/);
    expect(() => call([{ layer: { id: a.id }, factor: 0.5 }, { layer: { id: solid.id }, factor: 0.5 }])).toThrow(/not a text layer/);
    expect(() => call([{ layer: { id: a.id }, factor: 0.5 }, { layer: { id: a.id }, factor: 0.5 }])).toThrow(/twice/);
    expect(() => call([{ layer: { id: a.id }, factor: 0.5, expect_size: 80 }])).toThrow(/changed since it was measured/);
    expect(() => call([], GUARD)).toThrow(/items/);
    expect(() => call([{ layer: { id: a.id }, factor: 0.5 }], { project_path: "C:/other.aep" })).toThrow(/Target guard refused/);
    (a as any).property("ADBE Text Properties").property("ADBE Text Document").keys.push({});
    expect(() => call([{ layer: { id: a.id }, factor: 0.5 }])).toThrow(/keyed/);
    expect(docOf(b).fontSize).toBe(100);
    expect(undo.begun).toBe(0);
  });

  it("fittextLive puts a marked expression on Scale, replaces its own, refuses a foreign one, and removes it", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "Title", "HELLO", { size: 100 });
    const scale = (t.property("ADBE Transform Group") as any).property("ADBE Scale") as FakeProperty;
    const call = (extra: object) => A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, ...extra });
    call({ max_width: 400, max_height: 100 });
    expect(scale.expression.startsWith("// chroma-fit-text live")).toBe(true);
    expect(scale.expression).toContain("400 / r.width");
    expect(scale.expression).toContain("100 / r.height");
    expect(scale.expression).toContain("value * s");
    scale.expressionEnabled = true;
    expect(A.fittextMeasure({ comp_id: comp.id }).layers[0].live_fit).toEqual({ installed: true, ours: true, enabled: true, error: null, foreign: false });
    call({ max_width: 300 });
    expect(scale.expression).not.toContain("r.height");
    expect(call({ remove: true }).layers[0]).toMatchObject({ removed: true });
    expect(scale.expression).toBe("");
    scale.expression = "wiggle(2, 10)";
    scale.expressionEnabled = true;
    expect(() => call({ max_width: 300 })).toThrow(/not this tool's/);
    expect(call({ remove: true }).layers[0]).toMatchObject({ removed: false });
    expect(scale.expression).toBe("wiggle(2, 10)");
    expect(() => call({})).toThrow(/max_width and\/or max_height/);
    expect(undo.begun).toBe(4);
  });

  it("fittextBackdrop adds a shape layer directly below the text with size and position expressions", () => {
    const { comp, A, undo } = scene();
    const bg = comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1, 4) as FakeLayer;
    const t = textLayer(comp, 'Say "hi"', "HELLO", { size: 100 });
    expect(comp.layer(1)).toBe(t);
    const out = A.fittextBackdrop({ comp_id: comp.id, layer: { id: t.id }, padding: [24, 12], color: [0.1, 0.2, 0.3], opacity: 80, corner_radius: 6, expect: GUARD });
    expect(out.backdrop.name).toBe('Say "hi" Box');
    expect(out.backdrop.index).toBe(2);
    expect(comp.stack.map((l) => l.name)).toEqual(['Say "hi"', 'Say "hi" Box', "BG"]);
    expect(comp.layer(3)).toBe(bg);
    const shape = comp.layer(2)!;
    const group = (shape.property("ADBE Root Vectors Group") as any).property(1);
    const rect = group.property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
    expect(rect.property("ADBE Vector Rect Size").expression).toContain('thisComp.layer("Say \\"hi\\"")');
    // Size and position come from the text's corners in comp space, so Scale counts.
    const sizeExpr = rect.property("ADBE Vector Rect Size").expression;
    expect(sizeExpr).toContain("L.toComp([r.left, r.top])");
    expect(sizeExpr).toContain("L.toComp([r.left + r.width, r.top + r.height])");
    expect(sizeExpr).toContain("[x1 - x0 + 48, y1 - y0 + 24]");
    expect(rect.property("ADBE Vector Rect Position").expression).toContain("[(x0 + x1) / 2, (y0 + y1) / 2]");
    expect(rect.property("ADBE Vector Rect Roundness").value).toBe(6);
    const fill = group.property("ADBE Vectors Group").property("ADBE Vector Graphic - Fill");
    expect(fill.property("ADBE Vector Fill Color").value).toEqual([0.1, 0.2, 0.3, 1]);
    expect(fill.property("ADBE Vector Fill Opacity").value).toBe(80);
    expect(undo.begun).toBe(1);
    const read = A.fittextBackdropRead({ comp_id: comp.id, layer: { id: t.id }, backdrop_id: out.backdrop.id });
    expect(read.backdrop).toMatchObject({ id: out.backdrop.id, index: 2, kind: "shape", expression_error: null });
    expect(read.text.bounds.width).toBe(250);
    // A build without isNameSet reports nothing, not false.
    expect(read.text.name_set).toBeUndefined();
    expect(A.fittextBackdropRead({ comp_id: comp.id, layer: { id: t.id } }).backdrop).toBeUndefined();
  });

  it("fittextBackdrop checks its arguments before adding a layer", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "Title", "HELLO");
    const ok = { comp_id: comp.id, layer: { id: t.id }, padding: [1, 1], color: [0, 0, 0], opacity: 100, corner_radius: 0, expect: GUARD };
    expect(() => A.fittextBackdrop({ ...ok, padding: [1] })).toThrow(/padding/);
    expect(() => A.fittextBackdrop({ ...ok, color: [0, 2, 0] })).toThrow(/color/);
    expect(() => A.fittextBackdrop({ ...ok, opacity: 120 })).toThrow(/opacity/);
    expect(() => A.fittextBackdrop({ ...ok, corner_radius: -1 })).toThrow(/corner_radius/);
    const solid = comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1, 4) as FakeLayer;
    expect(() => A.fittextBackdrop({ ...ok, layer: { id: solid.id } })).toThrow(/not a text layer/);
    expect(comp.numLayers).toBe(2);
    expect(undo.begun).toBe(0);
  });

  it("takes a failed backdrop build back out in the same undo group", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "Title", "HELLO");
    // The fake's shape contents have no Roundness on a fill-less group: break the Rect factory by name.
    const realAdd = comp.layers.addShape;
    comp.layers.addShape = () => {
      const s = realAdd();
      (s.property("ADBE Root Vectors Group") as any).addProperty = () => {
        throw new Error("boom");
      };
      return s;
    };
    expect(() => A.fittextBackdrop({ comp_id: comp.id, layer: { id: t.id }, padding: [1, 1], color: [0, 0, 0], opacity: 100, corner_radius: 0, expect: GUARD })).toThrow(/boom/);
    expect(comp.numLayers).toBe(1);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });
});

describe("animate.jsx setText ranges under the fake AE", () => {
  const set = (A: any, comp: FakeComp, l: FakeLayer, extra: object) => A.setText({ comp_id: comp.id, layer: { id: l.id }, expect: GUARD, ...extra });

  it("styles every occurrence of a word and reads each range back", () => {
    const { comp, A, undo } = scene();
    const l = textLayer(comp, "T", "GO NOW OR NOW", { size: 60 });
    const out = set(A, comp, l, { ranges: [{ match: "NOW", style: { fauxBold: true, fillColor: [1, 0, 0], fontSize: 90 } }] });
    expect(out.ranges.map((r: any) => [r.start, r.end, r.text])).toEqual([[3, 6, "NOW"], [10, 13, "NOW"]]);
    const d = docOf(l);
    expect(d.chars.map((c) => c.fontSize)).toEqual([60, 60, 60, 90, 90, 90, 60, 60, 60, 60, 90, 90, 90]);
    expect(d.chars[3]).toMatchObject({ fauxBold: true, fillColor: [1, 0, 0], applyFill: true });
    expect(d.chars[0].fauxBold).toBe(false);
    expect(undo.begun).toBe(1);
    const back = A.getTextDocument({ comp_id: comp.id, layer: { id: l.id }, ranges: [{ start: 3, end: 6 }, { start: 0, end: 5 }] });
    expect(back.ranges[0]).toMatchObject({ text: "NOW", style: { fontSize: 90, fauxBold: true, fillColor: [1, 0, 0] }, mixed: [] });
    expect(back.ranges[1].mixed).toEqual(expect.arrayContaining(["fontSize", "fauxBold"]));
    expect(back.ranges[1].style.fontSize).toBeUndefined();
  });

  it("styles the first occurrence, offsets, and the new text of the same call", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "T", "old", { size: 60 });
    const out = set(A, comp, l, { text: "ab ab", ranges: [{ match: "ab", occurrence: "first", style: { tracking: 50 } }, { start: 3, style: { baselineShift: 8 } }] });
    expect(out.ranges.map((r: any) => [r.start, r.end])).toEqual([[0, 2], [3, 5]]);
    expect(docOf(l).text).toBe("ab ab");
    expect(docOf(l).chars.map((c) => c.tracking)).toEqual([50, 50, 0, 0, 0]);
    expect(docOf(l).chars.map((c) => c.baselineShift)).toEqual([0, 0, 0, 8, 8]);
  });

  it("works whether the build's range end is inclusive or not", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "T", "GO NOW", { size: 60, inclusiveEnd: true });
    set(A, comp, l, { ranges: [{ match: "NOW", style: { fauxItalic: true } }] });
    expect(docOf(l).chars.map((c) => c.fauxItalic)).toEqual([false, false, false, true, true, true]);
    const back = A.getTextDocument({ comp_id: comp.id, layer: { id: l.id }, ranges: [{ start: 3, end: 6 }] });
    expect(back.ranges[0].text).toBe("NOW");
  });

  it("refuses before writing: no ranges API, a word that is not there, or a range past the text", () => {
    const { comp, A, undo } = scene();
    const old = textLayer(comp, "Old", "GO NOW", { noRanges: true });
    expect(() => set(A, comp, old, { ranges: [{ match: "NOW", style: { fauxBold: true } }] })).toThrow(/24\.3/);
    const l = textLayer(comp, "T", "GO NOW", { size: 60 });
    expect(() => set(A, comp, l, { ranges: [{ match: "LATER", style: { fauxBold: true } }] })).toThrow(/not in the text/);
    expect(() => set(A, comp, l, { ranges: [{ start: 2, end: 99, style: { fauxBold: true } }] })).toThrow(/runs past the text/);
    expect(() => set(A, comp, l, { text: "X", ranges: [{ start: 0, end: 3, style: { fauxBold: true } }] })).toThrow(/runs past the text/);
    expect(() => set(A, comp, l, { ranges: [{ start: 0, end: 2, style: { fontSize: 5000 } }] })).toThrow(/fontSize/);
    expect(docOf(l).chars.every((c) => !c.fauxBold)).toBe(true);
    expect(docOf(l).text).toBe("GO NOW");
    expect(undo.begun).toBe(0);
  });

  it("keeps the layer's justification through the extra round trip", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "T", "GO NOW", { size: 60, dropsJustification: true });
    docOf(l).justification = PJ.RIGHT_JUSTIFY;
    set(A, comp, l, { ranges: [{ match: "NOW", style: { fauxBold: true } }] });
    expect(docOf(l).justification).toBe(PJ.RIGHT_JUSTIFY);
  });
});

describe("fittext.jsx review fixes under the fake AE", () => {
  it("fittextApply refuses a locked layer before writing any layer", () => {
    const { comp, A, undo } = scene();
    const a = textLayer(comp, "A", "one", { size: 100 });
    const b = textLayer(comp, "B", "two", { size: 100 });
    b.locked = true;
    const call = () => A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: a.id }, factor: 0.5 }, { layer: { id: b.id }, factor: 0.5 }], expect: GUARD });
    expect(call).toThrow(/locked/);
    expect(docOf(a).fontSize).toBe(100);
    expect(undo.begun).toBe(0);
  });

  it("fittextLive refuses a locked layer, but removing from one that has nothing of ours is fine", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "T", "HELLO", { size: 100 });
    t.locked = true;
    const call = (extra: object) => A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, ...extra });
    expect(() => call({ max_width: 300 })).toThrow(/locked/);
    expect(undo.begun).toBe(0);
    expect(call({ remove: true }).layers[0]).toMatchObject({ removed: false });
  });

  it("fittextLive writes the expression the server describes in a dry run", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "T", "HELLO", { size: 100 });
    const scale = (t.property("ADBE Transform Group") as any).property("ADBE Scale") as FakeProperty;
    A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, max_width: 400, max_height: 120 });
    expect(scale.expression).toBe(liveExpressionText(400, 120));
    A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, max_width: 400 });
    expect(scale.expression).toBe(liveExpressionText(400, undefined));
  });

  it("fittextApply leaves auto leading alone and scales a fixed one", () => {
    const { comp, A } = scene();
    const auto = textLayer(comp, "Auto", "one", { size: 100, leading: 120 });
    (docOf(auto) as any).autoLeading = true;
    const fixed = textLayer(comp, "Fixed", "two", { size: 100, leading: 120 });
    const out = A.fittextApply({
      comp_id: comp.id,
      items: [{ layer: { id: auto.id }, factor: 0.5 }, { layer: { id: fixed.id }, factor: 0.5 }],
      expect: GUARD,
    });
    expect(docOf(auto).leading).toBe(120);
    expect(docOf(auto).fontSize).toBe(50);
    expect(docOf(fixed).leading).toBe(60);
    expect(out.layers.map((l: any) => [l.auto_leading, l.leading_to])).toEqual([[true, null], [false, 60]]);
  });
});

describe("animate.jsx setText ranges: review fixes", () => {
  const set = (A: any, comp: FakeComp, l: FakeLayer, extra: object) => A.setText({ comp_id: comp.id, layer: { id: l.id }, expect: GUARD, ...extra });

  it("text, style and ranges are one write, so a stale read in the same script cannot undo them", () => {
    const { comp, A, undo } = scene();
    const l = textLayer(comp, "T", "old", { size: 60, staleAfterWrite: true });
    const out = set(A, comp, l, {
      text: "ab ab",
      style: { fontSize: 40 },
      ranges: [{ match: "ab", occurrence: "first", style: { tracking: 50 } }],
    });
    const d = docOf(l);
    expect(d.text).toBe("ab ab");
    expect(d.chars.map((c) => c.fontSize)).toEqual([40, 40, 40, 40, 40]);
    expect(d.chars.map((c) => c.tracking)).toEqual([50, 50, 0, 0, 0]);
    expect(out.applied).toEqual(expect.arrayContaining(["text", "fontSize", "ranges"]));
    expect(undo.begun).toBe(1);
  });

  it("writes the document exactly once for text plus ranges", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "T", "old", { size: 60 });
    const prop = (l.property("ADBE Text Properties") as any).property("ADBE Text Document") as FakeProperty;
    const realSet = prop.setValue.bind(prop);
    let writes = 0;
    prop.setValue = (v: unknown) => {
      writes++;
      realSet(v);
    };
    set(A, comp, l, { text: "ab ab", ranges: [{ match: "ab", style: { fauxBold: true } }] });
    expect(writes).toBe(1);
  });

  it("refuses text plus ranges when this build does not apply ranges to the new text, before any write", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "T", "old", { size: 60, rangesIgnoreNewText: true });
    expect(() => set(A, comp, l, { text: "ab ab", ranges: [{ start: 0, end: 2, style: { fauxBold: true } }] })).toThrow(/nothing was written/);
    expect(docOf(l).text).toBe("old");
    expect(docOf(l).chars.every((c) => !c.fauxBold)).toBe(true);
  });

  it("validates range field values before the undo group", () => {
    const { comp, A, undo } = scene();
    const l = textLayer(comp, "T", "GO NOW", { size: 60 });
    const bad = (style: object, re: RegExp) => expect(() => set(A, comp, l, { ranges: [{ start: 0, end: 2, style }] })).toThrow(re);
    bad({ font: 12 }, /font/);
    bad({ tracking: "wide" }, /tracking/);
    bad({ tracking: 99999 }, /tracking/);
    bad({ baselineShift: NaN }, /baselineShift/);
    bad({ strokeWidth: -1 }, /strokeWidth/);
    bad({ strokeWidth: 5000 }, /strokeWidth/);
    bad({ fillColor: [1, 0] }, /fillColor/);
    bad({ strokeColor: [0, 0, 2] }, /strokeColor/);
    bad({ fauxBold: "yes" }, /fauxBold/);
    expect(undo.begun).toBe(0);
    expect(docOf(l).chars.every((c) => !c.fauxBold)).toBe(true);
  });

  it("refuses overlapping ranges that set the same field, allows overlap of different fields", () => {
    const { comp, A, undo } = scene();
    const l = textLayer(comp, "T", "GO NOW OR LATER", { size: 60 });
    const red = [1, 0, 0];
    const blue = [0, 0, 1];
    expect(() =>
      set(A, comp, l, { ranges: [{ start: 0, end: 10, style: { fillColor: red } }, { match: "NOW", style: { fillColor: blue } }] })
    ).toThrow(/overlap and both set fill/);
    expect(() =>
      set(A, comp, l, { ranges: [{ start: 0, end: 10, style: { fillColor: red } }, { match: "NOW", style: { applyFill: false } }] })
    ).toThrow(/overlap and both set fill/);
    expect(undo.begun).toBe(0);
    // Touching ranges, and overlapping ranges with different fields, are fine.
    set(A, comp, l, { ranges: [{ start: 0, end: 3, style: { fillColor: red } }, { start: 3, end: 6, style: { fillColor: blue } }, { start: 0, end: 6, style: { fauxBold: true } }] });
    expect(docOf(l).chars[0].fillColor).toEqual(red);
    expect(docOf(l).chars[4].fillColor).toEqual(blue);
    expect(docOf(l).chars[5].fauxBold).toBe(true);
  });

  it("reads back more than 50 spans, and flags a match cut off at 200", () => {
    const { comp, A } = scene();
    const text = "a ".repeat(80);
    const l = textLayer(comp, "T", text, { size: 60 });
    const out = set(A, comp, l, { ranges: [{ match: "a", style: { fauxBold: true } }] });
    expect(out.ranges).toHaveLength(80);
    expect(out.matches_truncated).toBeUndefined();
    const back = A.getTextDocument({ comp_id: comp.id, layer: { id: l.id }, ranges: out.ranges.map((r: any) => ({ start: r.start, end: r.end })) });
    expect(back.ranges).toHaveLength(80);
    expect(back.ranges.every((r: any) => r.style.fauxBold === true)).toBe(true);

    const long = textLayer(comp, "Long", "a".repeat(250), { size: 60 });
    const cut = set(A, comp, long, { ranges: [{ match: "a", style: { fauxItalic: true } }] });
    expect(cut.ranges).toHaveLength(200);
    expect(cut.matches_truncated).toBe(true);
  });

  it("the tool compares only the ranges the read-back returned and fails the receipt for the rest", async () => {
    const setText = animateTools.find((t) => t.name === "ae_set_text")!;
    const doc = { text: "ab ab ab", justification: "left" };
    const written = [0, 3, 6].map((s) => ({ start: s, end: s + 2, text: "ab", style: { fauxBold: true } }));
    const read = (n: number) => written.slice(0, n).map((r) => ({ ...r, mixed: [] }));
    const { ctx } = fakeAe({
      getTextDocument: [{ document: doc }, { document: doc, ranges: read(2) }],
      setText: [{ ranges: written }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, ranges: [{ match: "ab", style: { fauxBold: true } }], expect: expectArg });
    const out: any = await setText.handler(args, ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ path: "ranges", expected: 3, actual: 2 })]));
    expect(out.unverified_ranges).toBe(1);
  });
});

describe("fittext and setText: second review fixes", () => {
  it("safe_area is compared on screen: the region is divided by the evaluated Scale", () => {
    const m = M({ scale: [200, 200], bounds: bounds(800, 50) });
    expect(regionFor(m, { maxW: 1536, maxH: 864, onScreen: true })).toEqual({ maxW: 768, maxH: 432 });
    expect(regionFor(m, { maxW: 400 })).toEqual({ maxW: 400 });
    // 800 wide before Scale is 1600 on screen: outside a 1536 title area, inside it at 100%.
    const plan = planFit(m, { region: { maxW: 1536, maxH: 864, onScreen: true }, minSize: 6, maxSize: 1296, allowGrow: false });
    expect(plan.status).toBe("resize");
    const plain = planFit(M({ bounds: bounds(800, 50) }), { region: { maxW: 1536, maxH: 864, onScreen: true }, minSize: 6, maxSize: 1296, allowGrow: false });
    expect(plain.status).toBe("fits");
  });

  it("fittextMeasure reports the evaluated Scale", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "T", "HELLO", { size: 50 });
    const scale = (t.property("ADBE Transform Group") as any).property("ADBE Scale") as FakeProperty;
    scale.setValue([150, 150]);
    expect(A.fittextMeasure({ comp_id: comp.id }).layers[0].scale).toEqual([150, 150]);
  });

  it("a disabled Scale expression of the user's is foreign, and live fit refuses to overwrite it", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "T", "HELLO", { size: 50 });
    const scale = (t.property("ADBE Transform Group") as any).property("ADBE Scale") as FakeProperty;
    scale.expression = "wiggle(1, 5)";
    scale.expressionEnabled = false;
    expect(A.fittextMeasure({ comp_id: comp.id }).layers[0].live_fit).toMatchObject({ installed: false, foreign: true });
    expect(() => A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, max_width: 300 })).toThrow(/already has an expression/);
    expect(scale.expression).toBe("wiggle(1, 5)");
    expect(undo.begun).toBe(0);
  });

  it("fittextApply refuses a text whose per-range sizes can't be scanned instead of flattening them", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "Long", "x".repeat(2100), { size: 10 });
    docOf(t).chars[2000].fontSize = 30;
    const out = A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5 }], expect: GUARD });
    expect(out.layers).toEqual([]);
    expect(out.skipped).toEqual([expect.objectContaining({ id: t.id, reason: expect.stringContaining("character by character") })]);
    expect(docOf(t).chars[2000].fontSize).toBe(30);
    expect(undo.begun).toBe(0);
    // Beside a readable layer, only the unreadable one is left out.
    const ok = textLayer(comp, "Short", "HI", { size: 20 });
    const both = A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5 }, { layer: { id: ok.id }, factor: 0.5 }], expect: GUARD });
    expect(both.layers).toHaveLength(1);
    expect(both.skipped).toHaveLength(1);
    expect(docOf(ok).fontSize).toBe(10);
    expect(docOf(t).chars[0].fontSize).toBe(10);
  });

  it("fittextLive re-enables a switched-off expression of ours, and the read tells ours from on", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "T", "HELLO", { size: 50 });
    const scale = (t.property("ADBE Transform Group") as any).property("ADBE Scale") as FakeProperty;
    const call = () => A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, max_width: 300 });
    call();
    scale.expressionEnabled = false;
    expect(A.fittextMeasure({ comp_id: comp.id }).layers[0].live_fit).toMatchObject({ ours: true, enabled: false, installed: false, foreign: false });
    call();
    expect(scale.expressionEnabled).toBe(true);
    const after = A.fittextMeasure({ comp_id: comp.id });
    expect(liveMismatches(false, after, [t.id])).toEqual([]);
    // If it stayed off, the receipt fails; and unlive still sees it as ours.
    scale.expressionEnabled = false;
    expect(liveMismatches(false, A.fittextMeasure({ comp_id: comp.id }), [t.id])).toHaveLength(1);
    expect(liveMismatches(true, A.fittextMeasure({ comp_id: comp.id }), [t.id])).toHaveLength(1);
    A.fittextLive({ comp_id: comp.id, layers: [{ id: t.id }], expect: GUARD, remove: true });
    expect(scale.expression).toBe("");
  });

  it("fittextApply counts the runs raised to min_size", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "Mixed", "ABCD", { size: 50 });
    docOf(t).chars[2].fontSize = 12;
    docOf(t).chars[3].fontSize = 12;
    const out = A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5, min_size: 10 }], expect: GUARD });
    expect(out.layers[0]).toMatchObject({ runs: 2, runs_clamped: 1 });
  });

  it("fittextBackdrop escapes line breaks in the layer name instead of changing the name", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "Two\nLines", "HELLO");
    const out = A.fittextBackdrop({ comp_id: comp.id, layer: { id: t.id }, padding: [1, 1], color: [0, 0, 0], opacity: 100, corner_radius: 0, expect: GUARD });
    const b = comp.layer(out.backdrop.index) as any;
    const rect = b.property("ADBE Root Vectors Group").property("ADBE Vector Group").property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
    expect(rect.property("ADBE Vector Rect Size").expression).toContain('thisComp.layer("Two\\nLines")');
  });

  it("fittextApply keeps every run inside min_size when shrinking", () => {
    const { comp, A } = scene();
    const t = textLayer(comp, "Mixed", "ABCD", { size: 50 });
    docOf(t).chars[2].fontSize = 12;
    docOf(t).chars[3].fontSize = 12;
    A.fittextApply({ comp_id: comp.id, items: [{ layer: { id: t.id }, factor: 0.5, min_size: 10 }], expect: GUARD });
    expect(docOf(t).chars.map((c) => c.fontSize)).toEqual([25, 25, 10, 10]);
  });

  it("fittextBackdrop refuses a name another layer shares, pins the text name, and refuses a locked text", () => {
    const { comp, A, undo } = scene();
    const t = textLayer(comp, "Title", "HELLO");
    const ok = { comp_id: comp.id, layer: { id: t.id }, padding: [1, 1], color: [0, 0, 0], opacity: 100, corner_radius: 0, expect: GUARD };
    textLayer(comp, "Title", "OTHER");
    comp.layer(1)!.name = "Title";
    expect(() => A.fittextBackdrop({ ...ok, layer: { id: t.id } })).toThrow(/also named/);
    expect(undo.begun).toBe(0);
    const solo = scene();
    const s = textLayer(solo.comp, "Solo", "HI");
    const base = { comp_id: solo.comp.id, layer: { id: s.id }, padding: [1, 1], color: [0, 0, 0], opacity: 100, corner_radius: 0, expect: GUARD };
    expect(() => solo.A.fittextBackdrop({ ...base, name: "Solo" })).toThrow(/share the text layer's name/);
    s.locked = true;
    expect(() => solo.A.fittextBackdrop(base)).toThrow(/locked/);
    expect(solo.comp.numLayers).toBe(1);
    s.locked = false;
    const out = solo.A.fittextBackdrop(base);
    expect(out.text).toMatchObject({ name: "Solo" });
  });

  it("ae_set_text does not compare a whole-document key that a range starting at 0 also sets", () => {
    expect(coveredByFirstRange("fontSize", [{ start: 0, end: 2, style: { fontSize: 80 } }])).toBe(true);
    expect(coveredByFirstRange("fontSize", [{ start: 1, end: 2, style: { fontSize: 80 } }])).toBe(false);
    expect(coveredByFirstRange("fillColor", [{ start: 0, end: 2, style: { applyFill: true } }])).toBe(true);
    expect(coveredByFirstRange("tracking", [{ start: 0, end: 2, style: { fontSize: 80 } }])).toBe(false);
  });

  it("the tool leaves such a key out of the receipt check", async () => {
    const setText = animateTools.find((t) => t.name === "ae_set_text")!;
    const before = { text: "abc", fontSize: 40, justification: "left" };
    const after = { text: "abc", fontSize: 80, justification: "left" };
    const written = [{ start: 0, end: 2, text: "ab", style: { fontSize: 80 } }];
    const { ctx } = fakeAe({
      getTextDocument: [{ document: before }, { document: after, ranges: written.map((r) => ({ ...r, mixed: [] })) }],
      setText: [{ ranges: written }],
    });
    const args = AeSetTextSchema.parse({ comp_id: 1, layer: { name: "T" }, style: { fontSize: 40 }, ranges: [{ start: 0, end: 2, style: { fontSize: 80 } }], expect: expectArg });
    const out: any = await setText.handler(args, ctx);
    expect(out.receipt.matches).toBe(true);
  });

  it("range text is bounded in readRanges and in the setText result", () => {
    const { comp, A } = scene();
    const l = textLayer(comp, "T", "a".repeat(25000), { size: 10 });
    const out = A.setText({ comp_id: comp.id, layer: { id: l.id }, expect: GUARD, ranges: [{ start: 0, end: 25000, style: { fauxBold: true } }] });
    expect(out.ranges[0].text.length).toBeLessThan(20100);
    const back = A.getTextDocument({ comp_id: comp.id, layer: { id: l.id }, ranges: [{ start: 0, end: 25000 }] });
    expect(back.ranges[0].text.length).toBeLessThan(20100);
  });
});
