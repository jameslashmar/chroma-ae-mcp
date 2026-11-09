/**
 * The legibility tools: the schemas, the pure contrast, overlap, pixel and
 * fix logic, the exact check's guarded flow against a fake bridge (with real
 * PNGs written where AE would render them), and legibility.jsx run under
 * node:vm against the simulated AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const failOverlay = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = (f: any, ...rest: any[]) => {
    if (failOverlay.on && String(f).includes("legibility_c")) throw new Error("disk full");
    return (real.writeFileSync as any)(f, ...rest);
  };
  return { ...real, default: { ...real, writeFileSync }, writeFileSync };
});
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeCreateLayerSchema } from "../src/tools/ext/layers.js";
import {
  AeCheckLegibilitySchema,
  AeCheckTextOverlapSchema,
  AeEstimateLegibilitySchema,
  analyzeEstimate,
  analyzeGlyphs,
  boxToRegion,
  contrastRatio,
  drawLegibilityOverlay,
  findOverlaps,
  frameDiffers,
  hiddenReason,
  judgeAnalysis,
  legibilityTools,
  overlapReport,
  ratioStats,
  relativeLuminance,
  requiredRatio,
  scrimOpacity,
  scrimOpacityOver,
  skippedEntry,
  suggestFixes,
  tempCompMismatches,
  testableLayers,
  type Box,
  type HostRead,
  type HostSample,
  type HostTextLayer,
  type LegibilityEntry,
} from "../src/tools/ext/legibility.js";
import { FakeLayer, FakeProject, GUARD, loadHost, type FakeComp } from "./support/fake-ae.js";

const tool = (name: string) => legibilityTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

// ---------- helpers ----------

type Px = [number, number, number, number];

/** An RGBA image from a per-pixel function. */
function image(width: number, height: number, fn: (x: number, y: number) => Px) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = p[0];
      data[i + 1] = p[1];
      data[i + 2] = p[2];
      data[i + 3] = p[3];
    }
  }
  return { width, height, data };
}

const grey = (v: number): Px => [v, v, v, 255];
const WHITE: Px = [255, 255, 255, 255];

function writePng(file: string, img: { width: number; height: number; data: Buffer }) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

const sample = (o: Partial<HostSample> = {}): HostSample => ({
  time: 1,
  visible: true,
  opacity: 100,
  box: [20, 10, 80, 30],
  box_reason: null,
  screen_font_px: 30,
  font_size: 30,
  bold: false,
  apply_fill: true,
  fill_rgb: [1, 1, 1],
  apply_stroke: false,
  stroke_rgb: null,
  mixed_fill: false,
  text: "Hello",
  ...o,
});

const textLayer = (o: Partial<HostTextLayer> = {}): HostTextLayer => ({
  index: 1,
  id: 10,
  name: "Title",
  enabled: true,
  in_point: 0,
  out_point: 5,
  parent_id: null,
  animators: 0,
  effects: 0,
  layer_styles: false,
  track_matte: null,
  is_track_matte: false,
  samples: [sample()],
  ...o,
});

const readOf = (layers: HostTextLayer[], times = [1]): HostRead => ({
  comp: { id: 1, name: "Main", width: 100, height: 40, duration: 5, frame_duration: 0.04, pixel_aspect: 1, resolution_factor: null },
  times,
  layers,
  total_layers: layers.length,
  text_layers: layers.length,
  truncated: false,
  solo_active: false,
});

// ---------- schemas ----------

describe("legibility schemas", () => {
  it("fill the defaults and bound the inputs", () => {
    const est = AeEstimateLegibilitySchema.parse({ comp_id: 1 });
    expect(est).toMatchObject({ level: "AA", large_text_px: 24, tolerance: 0.1, min_overlap: 0.02, annotate: true, max_size: 1600 });
    expect(AeEstimateLegibilitySchema.safeParse({ comp_id: 1, times: [] }).success).toBe(false);
    expect(AeEstimateLegibilitySchema.safeParse({ comp_id: 1, times: [0, 1, 2, 3, 4, 5, 6] }).success).toBe(false);
    expect(AeEstimateLegibilitySchema.safeParse({ comp_id: 1, level: "AAAA" }).success).toBe(false);
    expect(AeEstimateLegibilitySchema.safeParse({ comp_id: 1, min_ratio: 0.5 }).success).toBe(false);
    expect(AeEstimateLegibilitySchema.safeParse({ comp_id: 1, tolerance: 0.9 }).success).toBe(false);
    expect(AeEstimateLegibilitySchema.safeParse({ comp_id: 1, times: [-1] }).success).toBe(false);
  });

  it("ae_check_legibility needs expect, takes layer selectors and a sensitivity", () => {
    expect(AeCheckLegibilitySchema.safeParse({ comp_id: 1 }).success).toBe(false);
    const ok = AeCheckLegibilitySchema.parse({ comp_id: 1, layers: [{ name: "Title" }], expect: expectArg });
    expect(ok).toMatchObject({ sensitivity: 0.02, fixes: true });
    expect(AeCheckLegibilitySchema.safeParse({ comp_id: 1, layers: [{}], expect: expectArg }).success).toBe(false);
    expect(AeCheckLegibilitySchema.safeParse({ comp_id: 1, sensitivity: 0.5, expect: expectArg }).success).toBe(false);
  });

  it("ae_check_text_overlap allows more times than the render tools and needs no expect", () => {
    expect(AeCheckTextOverlapSchema.safeParse({ comp_id: 1, times: Array.from({ length: 12 }, (_, i) => i) }).success).toBe(true);
    expect(AeCheckTextOverlapSchema.safeParse({ comp_id: 1, times: Array.from({ length: 13 }, (_, i) => i) }).success).toBe(false);
  });

  it("exports the three tools, and only the exact one ends its description with the safety guidance", () => {
    expect(legibilityTools.map((t) => t.name)).toEqual(["ae_check_text_overlap", "ae_estimate_legibility", "ae_check_legibility"]);
    expect(tool("ae_check_legibility").description).toContain("(3) Jay may be editing live");
    expect(tool("ae_check_text_overlap").description).toContain("READ-ONLY");
    expect(tool("ae_estimate_legibility").description).toContain("READ-ONLY");
    expect(tool("ae_estimate_legibility").description).not.toContain("(3) Jay may be editing live");
  });
});

// ---------- contrast ----------

describe("contrast maths", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio(relativeLuminance(255, 255, 255), relativeLuminance(0, 0, 0))).toBeCloseTo(21, 5);
    expect(contrastRatio(relativeLuminance(255, 255, 255), relativeLuminance(255, 255, 255))).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 AA pass.
    expect(contrastRatio(relativeLuminance(255, 255, 255), relativeLuminance(0x76, 0x76, 0x76))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(relativeLuminance(255, 255, 255), relativeLuminance(0x77, 0x77, 0x77))).toBeLessThan(4.5);
  });

  it("requires 4.5 / 3 for AA and 7 / 4.5 for AAA, large from 24 px or bold from 18.7 px", () => {
    const base = { level: "AA" as const, bold: false, largeTextPx: 24 };
    expect(requiredRatio({ ...base, fontPx: 20 })).toEqual({ ratio: 4.5, large: false });
    expect(requiredRatio({ ...base, fontPx: 24 })).toEqual({ ratio: 3, large: true });
    expect(requiredRatio({ ...base, fontPx: 19, bold: true })).toEqual({ ratio: 3, large: true });
    expect(requiredRatio({ ...base, fontPx: 18, bold: true })).toEqual({ ratio: 4.5, large: false });
    expect(requiredRatio({ ...base, level: "AAA", fontPx: 12 }).ratio).toBe(7);
    expect(requiredRatio({ ...base, level: "AAA", fontPx: 40 }).ratio).toBe(4.5);
    expect(requiredRatio({ ...base, fontPx: null })).toEqual({ ratio: 4.5, large: false });
    expect(requiredRatio({ ...base, fontPx: 40, minRatio: 6 })).toEqual({ ratio: 6, large: true });
  });

  it("ratioStats counts the share below the ratio against the tolerance", () => {
    const sorted = Float32Array.from([1.5, 2, 3, 5, 6, 7, 8, 9, 10, 12]);
    const s = ratioStats(sorted, 4.5, 0.1);
    expect(s).toMatchObject({ min: 1.5, fail_share: 0.3, pass: false });
    expect(s.low).toBe(2);
    expect(ratioStats(sorted, 4.5, 0.3).pass).toBe(true);
    expect(ratioStats(sorted, 1.2, 0).pass).toBe(true);
    expect(ratioStats(new Float32Array(0), 4.5, 0.1).pass).toBe(false);
  });
});

// ---------- overlaps and regions ----------

describe("boxes", () => {
  const item = (index: number, box: Box) => ({ index, id: index * 10, name: `T${index}`, box });

  it("finds overlapping boxes and ranks them by share of the smaller", () => {
    const { pairs } = findOverlaps([item(1, [0, 0, 100, 50]), item(2, [90, 0, 200, 50]), item(3, [0, 40, 100, 60]), item(4, [300, 0, 400, 50])], 0.02);
    expect(pairs.map((p) => [p.a.index, p.b.index])).toEqual([
      [1, 3],
      [1, 2],
      [2, 3],
    ]);
    expect(pairs[0]).toMatchObject({ rect: [0, 40, 100, 50], share_of_smaller: 0.5 });
  });

  it("ignores touching boxes and overlaps under the minimum share", () => {
    expect(findOverlaps([item(1, [0, 0, 10, 10]), item(2, [10, 0, 20, 10])], 0).pairs).toEqual([]);
    expect(findOverlaps([item(1, [0, 0, 100, 100]), item(2, [99, 99, 200, 200])], 0.05).pairs).toEqual([]);
    expect(findOverlaps([item(1, [0, 0, 100, 100]), item(2, [99, 99, 200, 200])], 0.0001).pairs).toHaveLength(1);
  });

  it("maps a comp box to image pixels under a different render size, padded and clipped", () => {
    const r = boxToRegion([10, 10, 50, 30], { width: 100, height: 50 }, { width: 200, height: 100 }, 2);
    expect(r).toEqual({ x0: 16, y0: 16, x1: 104, y1: 64 });
    expect(boxToRegion([-50, -50, -10, -10], { width: 100, height: 50 }, { width: 100, height: 50 })).toBeNull();
    expect(boxToRegion([0, 0, 500, 500], { width: 100, height: 50 }, { width: 100, height: 50 })).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
  });

  it("overlapReport lists pairs per time and the layers it could not box", () => {
    const a = textLayer({ index: 1, id: 10, name: "A", samples: [sample({ box: [0, 0, 60, 30] }), sample({ time: 2, box: [0, 0, 60, 30] })] });
    const b = textLayer({ index: 2, id: 11, name: "B", samples: [sample({ box: [50, 10, 100, 40] }), sample({ time: 2, box: [70, 10, 100, 40] })] });
    const c = textLayer({ index: 3, id: 12, name: "C", enabled: false, samples: [sample({ visible: false }), sample({ time: 2, visible: false })] });
    const report = overlapReport(readOf([a, b, c], [1, 2]), 0.02);
    expect(report.overlap_count).toBe(1);
    expect(report.times_checked[0].overlaps[0]).toMatchObject({ a: { name: "A" }, b: { name: "B" } });
    expect(report.times_checked[1].overlaps).toEqual([]);
    expect(report.skipped.map((s) => s.status)).toEqual(["not_visible", "not_visible"]);
    expect(report.skipped[0].reason).toContain("switch is off");
  });

  it("skippedEntry explains hidden and unboxable samples, and passes measurable ones", () => {
    const l = textLayer();
    expect(skippedEntry(l, sample())).toBeNull();
    expect(skippedEntry(l, sample({ box: null, box_reason: "3D layer" }))).toMatchObject({ status: "not_checkable", reason: "3D layer" });
    expect(hiddenReason(l, sample({ time: 9, visible: false }))).toContain("in and out points");
    expect(hiddenReason(l, sample({ visible: false, opacity: 0 }))).toContain("opacity");
    expect(hiddenReason(l, sample({ visible: false }))).toContain("soloed");
    expect(hiddenReason({ ...l, enabled: false }, sample({ visible: false }))).toContain("switch is off");
  });

  it("testableLayers keeps layers that show with a box somewhere, capped", () => {
    const shown = textLayer({ id: 1, samples: [sample({ visible: false }), sample({ time: 2 })] });
    const hidden = textLayer({ id: 2, samples: [sample({ visible: false }), sample({ time: 2, box: null })] });
    expect(testableLayers(readOf([shown, hidden], [1, 2])).tested.map((l) => l.id)).toEqual([1]);
    const many = Array.from({ length: 105 }, (_, i) => textLayer({ id: i + 1, index: i + 1 }));
    const split = testableLayers(readOf(many));
    expect(split.tested).toHaveLength(100);
    expect(split.overflow).toHaveLength(5);
  });
});

// ---------- pixel analysis ----------

describe("analyzeGlyphs", () => {
  const W = 40;
  const H = 20;
  const region = { x0: 0, y0: 0, x1: W, y1: H };
  /** Background darkening to lightening left to right: 20 .. 230. */
  const bgAt = (x: number) => Math.round(20 + (x * 210) / (W - 1));
  const inBlock = (x: number, y: number) => x >= 5 && x < 35 && y >= 5 && y < 15;
  const copy = image(W, H, (x) => grey(bgAt(x)));
  const orig = image(W, H, (x, y) => (inBlock(x, y) ? WHITE : grey(bgAt(x))));

  it("measures white text over a background that gets lighter: passes on the left, fails on the right", () => {
    const a = analyzeGlyphs(orig, copy, region, { sensitivity: 0.02, required: 4.5 });
    expect(a.status).toBe("ok");
    expect(a.text_rgb).toEqual([255, 255, 255]);
    expect(a.core_pixels).toBe(300);
    const stats = ratioStats(a.ratios, 4.5, 0.1);
    expect(stats.fail_share).toBeGreaterThan(0.4);
    expect(stats.fail_share).toBeLessThan(0.65);
    expect(stats.pass).toBe(false);
    // Ascending, and the failing pixels sit on the light (right) side only.
    expect(Array.from(a.ratios)).toEqual(Array.from(a.ratios).sort((x, y) => x - y));
    expect(a.fail_bounds![0]).toBeGreaterThanOrEqual(17);
    expect(a.fail_bounds![2]).toBe(35);
    expect(a.bg.length).toBe(a.ratios.length * 3);
  });

  it("leaves excluded pixels out, and passes once the failing half is excluded", () => {
    const a = analyzeGlyphs(orig, copy, region, { sensitivity: 0.02, required: 4.5, exclude: [{ x0: 17, y0: 0, x1: W, y1: H }] });
    expect(a.excluded_pixels).toBe(23 * H);
    expect(ratioStats(a.ratios, 4.5, 0.1).pass).toBe(true);
  });

  it("takes the text colour from the glyph interior, not from a shadow around it", () => {
    const shadowed = image(W, H, (x, y) => {
      if (inBlock(x, y)) return WHITE;
      // A 2 px dark shadow ring around the block.
      if (x >= 3 && x < 37 && y >= 3 && y < 17) return grey(10);
      return grey(bgAt(x));
    });
    const a = analyzeGlyphs(shadowed, copy, region, { sensitivity: 0.02, required: 4.5 });
    expect(a.text_rgb).toEqual([255, 255, 255]);
    expect(a.core_pixels).toBe(300);
    expect(a.glyph_pixels).toBeGreaterThan(300);
  });

  it("reports no glyph when switching the text off changes nothing", () => {
    expect(analyzeGlyphs(copy, copy, region, { sensitivity: 0.02, required: 4.5 }).status).toBe("no_glyph");
    // A difference under the sensitivity is not text either.
    const faint = image(W, H, (x, y) => (inBlock(x, y) ? grey(bgAt(x) + 3) : grey(bgAt(x))));
    expect(analyzeGlyphs(faint, copy, region, { sensitivity: 0.02, required: 4.5 }).status).toBe("no_glyph");
    expect(analyzeGlyphs(faint, copy, region, { sensitivity: 0.005, required: 4.5 }).status).toBe("ok");
  });

  it("does not measure text over a transparent background", () => {
    const clear = image(W, H, () => [0, 0, 0, 0]);
    const a = analyzeGlyphs(orig, clear, region, { sensitivity: 0.02, required: 4.5 });
    expect(a.status).toBe("transparent");
    expect(a.transparent_pixels).toBeGreaterThan(0);
  });

  it("falls back to every glyph pixel for thin type with no flat interior", () => {
    // A one pixel wide stroke has no interior pixels.
    const stroke = image(W, H, (x, y) => (x === 10 && y >= 3 && y < 17 ? WHITE : grey(30)));
    const flat = image(W, H, () => grey(30));
    const a = analyzeGlyphs(stroke, flat, region, { sensitivity: 0.02, required: 4.5 });
    expect(a.status).toBe("ok");
    expect(a.core_pixels).toBe(14);
    expect(ratioStats(a.ratios, 4.5, 0.1).pass).toBe(true);
  });
});

describe("analyzeEstimate", () => {
  const W = 100;
  const H = 40;
  const box = { x0: 20, y0: 10, x1: 80, y1: 30 };
  const frame = (bg: number, text = true) =>
    image(W, H, (x, y) => (text && x >= 30 && x < 70 && y >= 15 && y < 25 ? WHITE : grey(bg)));

  it("compares the fill with the ring around the box", () => {
    const dark = analyzeEstimate(frame(20), box, 6, [255, 255, 255], { required: 4.5 });
    expect(dark.status).toBe("ok");
    expect(ratioStats(dark.ratios, 4.5, 0.1).pass).toBe(true);
    expect(dark.fill_seen_share).toBeCloseTo(400 / 1200, 3);
    const light = analyzeEstimate(frame(220), box, 6, [255, 255, 255], { required: 4.5 });
    expect(ratioStats(light.ratios, 4.5, 0.1).pass).toBe(false);
    expect(light.fail_bounds).not.toBeNull();
  });

  it("reports when the fill colour is nowhere in the box, and when there is no ring", () => {
    expect(analyzeEstimate(frame(20, false), box, 6, [255, 255, 255], { required: 4.5 }).fill_seen_share).toBe(0);
    const whole = { x0: 0, y0: 0, x1: W, y1: H };
    expect(analyzeEstimate(frame(20), whole, 6, [255, 255, 255], { required: 4.5 }).status).toBe("no_background");
  });
});

// ---------- fixes ----------

describe("fixes", () => {
  it("scrimOpacity finds the faintest scrim that lifts white text off a light background, or null", () => {
    const pct = scrimOpacity([255, 255, 255], [200, 200, 200], [0, 0, 0], 4.5)!;
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThan(80);
    // One step less would not do.
    const less = (v: number) => {
      const m = 200 * (1 - v / 100);
      return contrastRatio(relativeLuminance(255, 255, 255), relativeLuminance(m, m, m));
    };
    expect(less(pct)).toBeGreaterThanOrEqual(4.5);
    expect(less(pct - 1)).toBeLessThan(4.5 * 1.03);
    // Mid-grey text on mid-grey can't be rescued by a white scrim.
    expect(scrimOpacity([128, 128, 128], [130, 130, 130], [255, 255, 255], 7)).toBeNull();
  });

  const failing = (bg: number) => {
    const n = 100;
    const bgArr = new Uint8Array(n * 3).fill(bg);
    const ratios = new Float32Array(n).fill(contrastRatio(relativeLuminance(255, 255, 255), relativeLuminance(bg, bg, bg)));
    return { ratios, bg: bgArr };
  };
  const base = { compId: 1, layer: { index: 2, id: 10, name: "Title" }, textRgb: [255, 255, 255] as [number, number, number], required: 4.5, tolerance: 0.1, box: [20, 10, 80, 30] as Box, fontPx: 30, comp: { width: 100, height: 40 } };

  it("suggests black text and a black scrim for white text on a light background", () => {
    const fixes = suggestFixes({ ...base, analysis: failing(200) });
    const colour = fixes.find((f) => f.kind === "text_colour")!;
    expect(colour).toMatchObject({ hex: "#000000", reaches_ratio: true, expected_fail_share: 0 });
    const scrim = fixes.find((f) => f.kind === "scrim")!;
    expect(scrim.reaches_ratio).toBe(true);
    expect(scrim.colour).toEqual([0, 0, 0]);
    expect(scrim.opacity_percent! % 5).toBe(0);
    // Padded by 35% of the font size (11 px at 30 px, at least 8) and clipped to the comp.
    expect(scrim.rect).toEqual([9, 0, 91, 40]);
    expect(scrim.then![0]).toContain("[50, 20]");
    // The ready arguments are a valid ae_create_layer call once `expect` is added.
    const parsed = AeCreateLayerSchema.safeParse({ ...scrim.create_layer_args, expect: expectArg });
    expect(parsed.success).toBe(true);
    expect(scrim.create_layer_args).toMatchObject({ type: "solid", width: 82, height: 40, placement: { below: { id: 10 } } });
  });

  it("says when a scrim cannot help and a colour change alone does not reach the ratio", () => {
    // Text the same grey as a background that varies from black to white: nothing flat fixes it.
    const n = 100;
    const bg = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) bg.fill(Math.round((i * 255) / (n - 1)), i * 3, i * 3 + 3);
    const lum = relativeLuminance(128, 128, 128);
    const ratios = Float32Array.from(Array.from({ length: n }, (_, i) => contrastRatio(lum, relativeLuminance(bg[i * 3], bg[i * 3 + 1], bg[i * 3 + 2])))).sort();
    // Re-pair after sorting: rebuild bg in ratio order.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => contrastRatio(lum, relativeLuminance(bg[a * 3], 0, 0)) - contrastRatio(lum, relativeLuminance(bg[b * 3], 0, 0)));
    const sortedBg = new Uint8Array(n * 3);
    order.forEach((from, to) => sortedBg.fill(bg[from * 3], to * 3, to * 3 + 3));
    const fixes = suggestFixes({ ...base, textRgb: [128, 128, 128], required: 7, analysis: { ratios, bg: sortedBg } });
    expect(fixes.find((f) => f.kind === "text_colour")!.reaches_ratio).toBe(false);
  });

  it("returns nothing for an analysis with no pixels", () => {
    expect(suggestFixes({ ...base, analysis: { ratios: new Float32Array(0), bg: new Uint8Array(0) } })).toEqual([]);
  });
});

describe("drawLegibilityOverlay", () => {
  it("draws a red box on a failing layer and a magenta wash over an overlap", () => {
    const frame = PNG.sync.read(PNG.sync.write(Object.assign(new PNG({ width: 100, height: 40 }), { data: image(100, 40, () => grey(100)).data })));
    const entry: LegibilityEntry = {
      layer: { index: 3, id: 9, name: "T" },
      time: 1,
      status: "fail",
      measured: "pixels",
      box: [20, 10, 80, 30],
      ratio: { min: 1.2, low: 2.3, median: 3 },
    };
    const out = drawLegibilityOverlay(frame, { width: 100, height: 40 }, [entry], [{ a: { index: 1, id: 1, name: "a" }, b: { index: 2, id: 2, name: "b" }, rect: [60, 12, 80, 28], area: 320, share_of_smaller: 0.3 }], 1600);
    expect(out.width).toBe(100);
    const at = (x: number, y: number) => Array.from(out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3));
    expect(at(20, 20)).toEqual([255, 48, 48]);
    expect(at(70, 20)).not.toEqual([100, 100, 100]);
    expect(at(2, 38)).toEqual([100, 100, 100]);
  });

  it("shrinks to max_size", () => {
    const frame = Object.assign(new PNG({ width: 400, height: 200 }), { data: image(400, 200, () => grey(50)).data });
    expect(drawLegibilityOverlay(frame, { width: 400, height: 200 }, [], [], 200).width).toBe(200);
  });
});

describe("guide layers", () => {
  it("say they are not rendered", () => {
    expect(hiddenReason(textLayer(), sample({ visible: false, guide: true }))).toContain("guide layer");
  });
});

describe("frameDiffers and tempCompMismatches", () => {
  it("frameDiffers sees a single changed pixel above the sensitivity", () => {
    const a = image(4, 4, () => grey(10));
    const b = image(4, 4, (x, y) => (x === 2 && y === 3 ? grey(40) : grey(10)));
    expect(frameDiffers(a, a, 0.02)).toBe(false);
    expect(frameDiffers(a, b, 0.02)).toBe(true);
    expect(frameDiffers(a, b, 0.2)).toBe(false);
  });

  it("flags a copy that is left behind and an item count that moved", () => {
    const before = { num_items: 4, comps: 2, temp_comps: 0 };
    expect(tempCompMismatches(before, { ...before }, null, 9)).toEqual([]);
    const m = tempCompMismatches(before, { num_items: 5, comps: 3, temp_comps: 1 }, "locked", 9);
    expect(m.map((x) => x.path)).toEqual(["temp_comp", "temp_comps"]);
    expect(m[0].message).toContain("chroma-legibility-copy");
  });
});

// ---------- the tools against a fake bridge ----------

const tmpDirs: string[] = [];
const origLocalAppData = process.env.LOCALAPPDATA;

const origHome = process.env.HOME;
beforeEach(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-legibility-"));
  tmpDirs.push(d);
  process.env.LOCALAPPDATA = process.env.HOME = d;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface AeOpts {
  read?: HostRead;
  /** Background grey of both renders. */
  bg?: number;
  /** Draw the text block in the original only (default true). */
  withText?: boolean;
  failRemove?: boolean;
  failBegin?: boolean;
  failAfter?: boolean;
  /** The render of the copy is not a PNG. */
  corruptCopy?: boolean;
  noCopyId?: boolean;
  afterItems?: number;
  /** Comps already named chroma-legibility-copy before the run (and still there after). */
  olderCopies?: number;
  /** The tested layer 10 of the original comp is switched off after the run. */
  originalOffAfter?: boolean;
  /** Every render of the original times out (AE blocked). */
  renderTimesOut?: boolean;
  /** The nth render (1-based) times out and so does every one after it. */
  renderTimesOutFrom?: number;
  /** The nth render (1-based) and every one after it is not a PNG. */
  corruptFrom?: number;
}

const COPY_ID = 77;

/** A PanelHost whose AE answers the legibility host calls and writes real PNGs where snapshotFrame is asked to. */
function fakeAe(opts: AeOpts = {}) {
  const calls: Array<{ fn: string; script: string }> = [];
  let renders = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-legibility-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const read = opts.read ?? readOf([textLayer()]);
  let states = 0;
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      const ok = (result: unknown) => ({ ok: true, result, durationMs: 1 });
      if (fn === "checkGuard") return ok({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
      if (fn === "legibilityRead") return ok(read);
      if (fn === "legibilityState") {
        states++;
        if (states === 2 && opts.failAfter) throw new Error("read failed");
        const state: Record<string, unknown> = { num_items: states === 1 ? 4 : (opts.afterItems ?? 4), comps: 2, temp_comps: opts.olderCopies ?? 0 };
        if (script.includes("layer_ids")) state.layers = [{ id: 10, enabled: !(states > 1 && opts.originalOffAfter) }];
        return ok(state);
      }
      if (fn === "legibilityBegin") {
        if (opts.failBegin) throw new Error("Layer 1 is not the layer read earlier");
        const res: Record<string, unknown> = { copy_name: "chroma-legibility-copy Main", switched_off: 1, comp_size: [100, 40] };
        if (!opts.noCopyId) res.copy_id = COPY_ID;
        return ok(res);
      }
      if (fn === "snapshotFrame") {
        renders += 1;
        if (opts.renderTimesOut || (opts.renderTimesOutFrom !== undefined && renders >= opts.renderTimesOutFrom)) throw new BridgeError({ kind: "timeout", message: "AE did not answer" });
        const out = JSON.parse(`"${/"output_path":"([^"]+)"/.exec(script)![1]}"`) as string;
        const isCopy = script.includes(`"comp_id":${COPY_ID}`);
        const bg = opts.bg ?? 20;
        const withText = !isCopy && opts.withText !== false;
        if ((isCopy && opts.corruptCopy) || (opts.corruptFrom !== undefined && renders >= opts.corruptFrom)) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, "not a png at all");
        } else {
          writePng(out, image(100, 40, (x, y) => (withText && x >= 30 && x < 70 && y >= 15 && y < 25 ? WHITE : grey(bg))));
        }
        return ok({ path: out });
      }
      if (fn === "legibilityEnd") {
        if (opts.failRemove) throw new Error("item is locked");
        return ok({ removed: true, copy_id: COPY_ID });
      }
      throw new Error(`Unexpected script: ${script}`);
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn) };
}

type Out = Record<string, any>;
const checkArgs = (extra: Record<string, unknown> = {}) => AeCheckLegibilitySchema.parse({ comp_id: 1, times: [1], expect: expectArg, ...extra });

describe("ae_check_text_overlap", () => {
  it("reads with the slow timeout", async () => {
    const { ctx } = fakeAe({ read: readOf([textLayer()]) });
    let seen: number | undefined;
    const host = ctx.bridge as any;
    const orig = host.callHost.bind(host);
    host.callHost = (fn: string, args: unknown, opts: any) => {
      seen = opts.timeoutMs;
      return orig(fn, args, opts);
    };
    await tool("ae_check_text_overlap").handler(AeCheckTextOverlapSchema.parse({ comp_id: 1 }), ctx);
    expect(seen).toBeGreaterThanOrEqual(600000);
  });

  it("reads once, with no guard and no write", async () => {
    const a = textLayer({ index: 1, id: 10, name: "A", samples: [sample({ box: [0, 0, 60, 30] })] });
    const b = textLayer({ index: 2, id: 11, name: "B", samples: [sample({ box: [50, 10, 100, 40] })] });
    const { ctx, fns } = fakeAe({ read: readOf([a, b]) });
    const out = (await tool("ae_check_text_overlap").handler(AeCheckTextOverlapSchema.parse({ comp_id: 1 }), ctx)) as Out;
    expect(fns()).toEqual(["legibilityRead"]);
    expect(out).toMatchObject({ ok: true, read_only: true, overlap_count: 1 });
    expect(out.times_checked[0].overlaps[0].rect).toEqual([50, 10, 60, 30]);
  });
});

describe("ae_estimate_legibility flow", () => {
  const args = (extra: Record<string, unknown> = {}) => AeEstimateLegibilitySchema.parse({ comp_id: 1, times: [1], ...extra });

  it("reads and renders the original only, never touching the project", async () => {
    const { ctx, fns } = fakeAe({ bg: 20 });
    const out = (await tool("ae_estimate_legibility").handler(args(), ctx)) as Out;
    expect(fns()).toEqual(["legibilityRead", "snapshotFrame"]);
    expect(out).toMatchObject({ ok: true, read_only: true, mode: "estimate", verdict: "pass", pass: 1, fail: 0 });
    const entry = out.times_checked[0].layers[0];
    expect(entry).toMatchObject({ status: "pass", measured: "estimate", required_ratio: 3, large_text: true });
    expect(entry.notes.join(" ")).toContain("An estimate");
    expect(fs.existsSync(out.times_checked[0].annotated_path)).toBe(true);
    expect(out.notes[0]).toContain("ESTIMATE");
  });

  it("fails white text over a light picture, and says nothing is conclusive when the fill is not on screen", async () => {
    const light = fakeAe({ bg: 220 });
    const failed = (await tool("ae_estimate_legibility").handler(args(), light.ctx)) as Out;
    expect(failed.verdict).toBe("fail");
    expect(failed.times_checked[0].layers[0].fail_box).toBeDefined();
    const noFill = fakeAe({ bg: 20, withText: false });
    const out = (await tool("ae_estimate_legibility").handler(args({ annotate: false }), noFill.ctx)) as Out;
    expect(out.times_checked[0].layers[0]).toMatchObject({ status: "inconclusive" });
    expect(out.times_checked[0].layers[0].reason).toContain("no pixel in the box has the layer's fill colour");
    expect(out.times_checked[0].annotated_path).toBeUndefined();
    expect(out.verdict).toBe("inconclusive");
  });

  it("is inconclusive for a stroke-only layer, and warns about animators", async () => {
    const stroke = textLayer({ samples: [sample({ apply_fill: false, fill_rgb: null })] });
    const { ctx } = fakeAe({ read: readOf([stroke]) });
    const out = (await tool("ae_estimate_legibility").handler(args(), ctx)) as Out;
    expect(out.times_checked[0].layers[0].reason).toContain("no fill");
    const animated = textLayer({ animators: 2 });
    const second = fakeAe({ read: readOf([animated]), bg: 20 });
    const out2 = (await tool("ae_estimate_legibility").handler(args(), second.ctx)) as Out;
    expect(out2.times_checked[0].layers[0].notes.join(" ")).toContain("2 text animator");
  });
});

describe("ae_check_legibility flow", () => {
  it("guards, checkpoints, duplicates, renders both, removes the copy, and reads back in a separate call", async () => {
    const { ctx, fns, calls } = fakeAe({ bg: 20 });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(fns()).toEqual(["legibilityRead", "checkGuard", "legibilityState", "legibilityBegin", "snapshotFrame", "snapshotFrame", "legibilityEnd", "legibilityState"]);
    // Begin names the layer by index, id and name, and carries expect; the original is rendered before the copy.
    expect(calls[3].script).toContain('"layers":[{"index":1,"id":10,"name":"Title"}]');
    expect(calls[3].script).toContain('"expect"');
    expect(calls[4].script).toContain('"comp_id":1,');
    expect(calls[5].script).toContain(`"comp_id":${COPY_ID}`);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.temp_comp).toEqual({ copy_removed: true, switched_off: 1 });
    expect(out).toMatchObject({ mode: "exact", verdict: "pass", pass: 1 });
    const row = out.times_checked[0];
    expect(row.frame_changed).toBe(true);
    expect(row.layers[0]).toMatchObject({ status: "pass", measured: "pixels", text_colour: "#ffffff", background_mean: "#141414" });
    expect(row.layers[0].ratio.min).toBeGreaterThan(15);
    expect(row.frames.original).not.toBe(row.frames.copy);
    expect(fs.existsSync(row.annotated_path)).toBe(true);
  });

  it("fails white text over a light picture and suggests fixes with ready ae_create_layer arguments", async () => {
    const { ctx } = fakeAe({ bg: 200 });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(out.verdict).toBe("fail");
    expect(out.worst[0]).toMatchObject({ layer: { name: "Title" }, required: 3 });
    const entry = out.times_checked[0].layers[0];
    expect(entry.status).toBe("fail");
    expect(entry.fail_share).toBe(1);
    expect(entry.fail_box).toBeDefined();
    const scrim = entry.fixes.find((f: Out) => f.kind === "scrim");
    expect(scrim.reaches_ratio).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...scrim.create_layer_args, expect: expectArg }).success).toBe(true);
    expect(entry.fixes.find((f: Out) => f.kind === "text_colour").hex).toBe("#000000");
  });

  it("leaves fixes out when asked", async () => {
    const { ctx } = fakeAe({ bg: 200 });
    const out = (await tool("ae_check_legibility").handler(checkArgs({ fixes: false, annotate: false }), ctx)) as Out;
    expect(out.times_checked[0].layers[0].fixes).toBeUndefined();
    expect(out.times_checked[0].annotated_path).toBeUndefined();
  });

  it("calls text that the diff cannot find a failure, unless the copy is simply identical everywhere", async () => {
    // Both renders show no text: nothing differs anywhere, so the render itself is in doubt.
    const same = fakeAe({ bg: 20, withText: false });
    const a = (await tool("ae_check_legibility").handler(checkArgs(), same.ctx)) as Out;
    expect(a.times_checked[0].frame_changed).toBe(false);
    expect(a.times_checked[0].layers[0]).toMatchObject({ status: "inconclusive" });
    expect(a.times_checked[0].layers[0].reason).toContain("cached frame");
    expect(a.verdict).toBe("inconclusive");
  });

  it("refuses before the checkpoint and before anything is duplicated when no text shows", async () => {
    const hidden = textLayer({ enabled: false, samples: [sample({ visible: false })] });
    const { ctx, fns } = fakeAe({ read: readOf([hidden]) });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(out).toMatchObject({ ok: false, error: "nothing_to_check" });
    expect(out.skipped[0]).toMatchObject({ status: "not_visible", reason: expect.stringContaining("switch is off") });
    expect(fns()).toEqual(["legibilityRead"]);
    const none = fakeAe({ read: readOf([]) });
    const out2 = (await tool("ae_check_legibility").handler(checkArgs(), none.ctx)) as Out;
    expect(out2.message).toContain("no text layers");
  });

  it("lists layers it can't box next to the ones it checked", async () => {
    const solid3d = textLayer({ index: 2, id: 11, name: "Floating", samples: [sample({ box: null, box_reason: "3D layer, or parented to one: its box depends on the camera" })] });
    const { ctx } = fakeAe({ read: readOf([textLayer(), solid3d]), bg: 20 });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ status: "not_checkable", layer: { name: "Floating" } });
    expect(out.checked).toBe(1);
  });

  it("excludes another tested text box from the pixels it judges and reports the overlap", async () => {
    // Two boxes sharing x 50..80; the second layer's glyphs would otherwise count as the first one's background.
    const a = textLayer({ index: 1, id: 10, name: "A", samples: [sample({ box: [20, 10, 80, 30] })] });
    const b = textLayer({ index: 2, id: 11, name: "B", samples: [sample({ box: [50, 10, 90, 30] })] });
    const { ctx } = fakeAe({ read: readOf([a, b]), bg: 20 });
    const out = (await tool("ae_check_legibility").handler(checkArgs({ annotate: false }), ctx)) as Out;
    const row = out.times_checked[0];
    expect(row.overlaps).toHaveLength(1);
    expect(row.overlaps[0].rect).toEqual([50, 10, 80, 30]);
    expect(row.layers[0].status).toBe("pass");
    expect(row.layers[0].notes.join(" ")).toContain("shared with another text box");
    // B's box lies inside A's padded box here, so nothing is left to measure: not a verdict either way.
    expect(row.layers[1]).toMatchObject({ status: "inconclusive" });
    expect(row.layers[1].reason).toContain("shared with another text layer");
  });

  it("reports a time whose render cannot be read, still removes the copy, and keeps the receipt clean", async () => {
    const { ctx, fns } = fakeAe({ corruptCopy: true });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(fns().slice(-2)).toEqual(["legibilityEnd", "legibilityState"]);
    expect(out.temp_comp.copy_removed).toBe(true);
    expect(out.times_checked[0].error).toBeDefined();
    expect(out.times_checked[0].layers[0]).toMatchObject({ status: "inconclusive", measured: "none" });
    expect(out.receipt.matches).toBe(true);
  });

  it("reports a copy that could not be removed in the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({ failRemove: true });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(out.applied).toBe(true);
    expect(out.temp_comp.copy_removed).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt)).toContain("chroma-legibility-copy");
  });

  it("reports a failed read-back and an item count that moved without throwing", async () => {
    const failed = fakeAe({ failAfter: true });
    const a = (await tool("ae_check_legibility").handler(checkArgs(), failed.ctx)) as Out;
    expect(a.applied).toBe(true);
    expect(a.receipt.matches).toBe(false);
    expect(JSON.stringify(a.receipt)).toContain("Do not resend");
    // An item added by hand during the renders is not this run's doing: the receipt stays clean.
    const moved = fakeAe({ afterItems: 5 });
    const b = (await tool("ae_check_legibility").handler(checkArgs(), moved.ctx)) as Out;
    expect(b.receipt.matches).toBe(true);
  });

  it("stops rendering after a timeout, marks the rest inconclusive, still removes the copy and says AE is blocked", async () => {
    const two = readOf([textLayer({ samples: [sample({ time: 1 }), sample({ time: 2 })] })], [1, 2]);
    const { ctx, fns } = fakeAe({ read: two, renderTimesOut: true });
    const out = (await tool("ae_check_legibility").handler(checkArgs({ times: [1, 2] }), ctx)) as Out;
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(1);
    expect(fns().slice(-2)).toEqual(["legibilityEnd", "legibilityState"]);
    expect(out.ae_blocked).toContain("ae_dialogs");
    expect(out.times_checked).toHaveLength(2);
    expect(out.times_checked[1].layers[0]).toMatchObject({ status: "inconclusive" });
    expect(out.temp_comp.copy_removed).toBe(true);
  });

  it("the estimate stops rendering after a timeout too", async () => {
    const two = readOf([textLayer({ samples: [sample({ time: 1 }), sample({ time: 2 })] })], [1, 2]);
    const { ctx, fns } = fakeAe({ read: two, renderTimesOut: true });
    const out = (await tool("ae_estimate_legibility").handler(AeEstimateLegibilitySchema.parse({ comp_id: 1, times: [1, 2] }), ctx)) as Out;
    expect(fns().filter((f) => f === "snapshotFrame")).toHaveLength(1);
    expect(out.ae_blocked).toBeDefined();
  });

  it("the estimate marks a time that could not be rendered inconclusive instead of passing on the rest", async () => {
    const two = readOf([textLayer({ samples: [sample({ time: 1 }), sample({ time: 2 })] })], [1, 2]);
    const { ctx } = fakeAe({ read: two, renderTimesOutFrom: 2 });
    const out = (await tool("ae_estimate_legibility").handler(AeEstimateLegibilitySchema.parse({ comp_id: 1, times: [1, 2] }), ctx)) as Out;
    expect(out.ae_blocked).toBeDefined();
    expect(out.times_checked[1].layers[0]).toMatchObject({ status: "inconclusive" });
    expect(out.verdict).toBe("inconclusive");
    expect(out.inconclusive).toBeGreaterThanOrEqual(1);
  });

  it("the estimate marks a time inconclusive when its frame cannot be decoded", async () => {
    const two = readOf([textLayer({ samples: [sample({ time: 1 }), sample({ time: 2 })] })], [1, 2]);
    const { ctx } = fakeAe({ read: two, corruptFrom: 2 });
    const out = (await tool("ae_estimate_legibility").handler(AeEstimateLegibilitySchema.parse({ comp_id: 1, times: [1, 2] }), ctx)) as Out;
    expect(out.times_checked[1].error).toBeDefined();
    expect(out.times_checked[1].layers[0]).toMatchObject({ status: "inconclusive" });
    expect(out.verdict).toBe("inconclusive");
  });

  it("lists a layer whose box lies outside the frame under skipped instead of dropping it", async () => {
    const off = textLayer({ samples: [sample({ box: [500, 500, 600, 540] })] });
    const { ctx } = fakeAe({ read: readOf([textLayer({ id: 11, index: 2, name: "In" }), off]) });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(out.skipped.some((e: any) => e.layer.id === 10 && e.status === "not_checkable" && /outside the frame/.test(e.reason))).toBe(true);
    expect(out.checked).toBe(1);
  });

  it("registers the removal as in flight so the session hook does not report the temp comp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-legibility-s-"));
    tmpDirs.push(dir);
    const tracker = installSessionTracking({ dataDir: dir });
    try {
      const { ctx } = fakeAe();
      const host = ctx.bridge as any;
      const orig = host.evalRaw.bind(host);
      const seen: Record<string, boolean> = {};
      host.evalRaw = (p: any) => {
        if (p.mutates) seen[p.id] = tracker.isInflight(p.id);
        return orig(p);
      };
      await tool("ae_check_legibility").handler(checkArgs(), ctx);
      const ids = Object.keys(seen);
      expect(ids.some((id) => id.endsWith("_remove"))).toBe(true);
      expect(Object.values(seen).every((v) => v === true)).toBe(true);
    } finally {
      resetSessionTracking();
    }
  });

  it("keeps each judged row once when the annotated picture cannot be written", async () => {
    const { ctx } = fakeAe();
    failOverlay.on = true;
    let out: Out;
    try {
      out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    } finally {
      failOverlay.on = false;
    }
    expect(out.checked).toBe(1);
    expect(out.times_checked[0].annotate_error).toContain("disk full");
    expect(out.times_checked[0].layers).toHaveLength(1);
    expect(out.times_checked[0].layers[0].status).toBe("pass");
  });

  it("stops at a failed begin without rendering or removing anything", async () => {
    const { ctx, fns } = fakeAe({ failBegin: true });
    await expect(tool("ae_check_legibility").handler(checkArgs(), ctx)).rejects.toThrow(/not the layer read earlier/);
    expect(fns()).toEqual(["legibilityRead", "checkGuard", "legibilityState", "legibilityBegin"]);
  });

  it("does not render when AE gives no id for the copy, and says so", async () => {
    const { ctx, fns } = fakeAe({ noCopyId: true });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(fns()).not.toContain("snapshotFrame");
    expect(out.temp_comp.copy_removed).toBe(false);
    expect(out.times_checked.at(-1).error).toContain("no id for the temporary comp");
    expect(out.receipt.matches).toBe(false);
  });

  it("names layers past the 100 it tests per call instead of dropping them", async () => {
    const many = Array.from({ length: 101 }, (_, i) => textLayer({ index: i + 1, id: i + 1, name: `T${i + 1}`, samples: [sample({ box: [0, 0, 5, 5] })] }));
    const { ctx, calls } = fakeAe({ read: readOf(many), bg: 20 });
    const out = (await tool("ae_check_legibility").handler(checkArgs({ annotate: false }), ctx)) as Out;
    const begin = calls.find((c) => c.fn === "legibilityBegin")!;
    expect((begin.script.match(/"index"/g) ?? []).length).toBe(100);
    expect(out.times_checked[0].layers.length).toBeLessThanOrEqual(100);
  });
});

// ---------- the host functions under node:vm ----------

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const text = (name: string, rect = { left: -50, top: -20, width: 100, height: 40 }) => {
    const l = comp.layers.addText(name) as FakeLayer;
    l.rect = rect;
    return l;
  };
  return { project, comp, text };
}

/** comp.duplicate for the fake: a new comp with the same layers (new ids, same indexes and names). */
function allowDuplicate(project: FakeProject, comp: FakeComp, o: { renameLayers?: boolean } = {}) {
  (comp as any).duplicate = () => {
    const copy = project.addComp(`${comp.name} 2`, comp.width, comp.height, comp.duration);
    for (const l of comp.stack) {
      const c = new FakeLayer(copy, o.renameLayers ? `${l.name} x` : l.name, l.reflect.name);
      c.rect = { ...l.rect };
      // A locked layer refuses switch changes, as AE does.
      let on = l.enabled;
      c.locked = l.locked;
      Object.defineProperty(c, "enabled", {
        get: () => on,
        set: (v: boolean) => {
          if (c.locked) throw new Error("layer is locked");
          on = v;
        },
      });
      copy.stack.push(c);
    }
    return copy;
  };
}

describe("legibility.jsx reads", () => {
  it("boxes a text layer through its transforms and parents, and reports its style", () => {
    const { project, comp, text } = scene();
    const title = text("Title");
    title.transform("ADBE Scale").setValue([200, 200, 100]);
    const rig = comp.layers.addNull() as FakeLayer;
    rig.transform("ADBE Position").setValue([100, 50, 0]);
    // Parenting multiplies matrices: a parent at (100, 50) with a layer at (320, 180).
    title.parent = rig;
    title.transform("ADBE Position").setValue([20, 30, 0]);
    const { A, undo } = loadHost(project, ["legibility.jsx"]);
    const out = A.legibilityRead({ comp_id: comp.id, times: [1] });
    expect(out.times).toEqual([1]);
    expect(out.text_layers).toBe(1);
    const l = out.layers[0];
    expect(l).toMatchObject({ name: "Title", enabled: true, parent_id: rig.id, animators: 0, effects: 0, layer_styles: false, track_matte: null });
    const s = l.samples[0];
    // Rect (-50,-20,100,40) at scale 200% is (-100,-40)..(100,40), moved by (20,30) then (100,50).
    expect(s.box).toEqual([20, 40, 220, 120]);
    expect(s.screen_font_px).toBe(144);
    expect(s).toMatchObject({ visible: true, opacity: 100, font_size: 72, bold: false, apply_fill: true, fill_rgb: [1, 1, 1], apply_stroke: false, text: "Title" });
    expect(undo.begun).toBe(0);
  });

  it("lists only text layers, defaults to the comp's time, clamps times and flags bold type", () => {
    const { project, comp, text } = scene();
    text("Title");
    comp.layers.addNull();
    comp.layers.addShape();
    comp.time = 99;
    const doc = (comp.layer("Title") as FakeLayer).property("ADBE Text Properties") as any;
    doc.property("ADBE Text Document").staticValue.fontStyle = "Bold Italic";
    const { A } = loadHost(project, ["legibility.jsx"]);
    const out = A.legibilityRead({ comp_id: comp.id });
    expect(out.layers).toHaveLength(1);
    expect(out.times[0]).toBeCloseTo(4 - 1 / 25, 6);
    expect(out.layers[0].samples[0].bold).toBe(true);
    expect(A.legibilityRead({ comp_id: comp.id, times: [0, 100] }).times.map((t: number) => Math.round(t * 100) / 100)).toEqual([0, 3.96]);
  });

  it("marks switched-off, out-of-range, transparent and soloed layers as not showing", () => {
    const { project, comp, text } = scene();
    const off = text("Off");
    off.enabled = false;
    const early = text("Early");
    early.inPoint = 2;
    const clear = text("Clear");
    clear.transform("ADBE Opacity").setValue(0);
    const { A } = loadHost(project, ["legibility.jsx"]);
    const byName = (r: any, n: string) => r.layers.find((l: any) => l.name === n).samples[0];
    const r1 = A.legibilityRead({ comp_id: comp.id, times: [1] });
    expect(byName(r1, "Off").visible).toBe(false);
    expect(byName(r1, "Early").visible).toBe(false);
    expect(byName(r1, "Clear").visible).toBe(false);
    expect(A.legibilityRead({ comp_id: comp.id, times: [2.5] }).layers.find((l: any) => l.name === "Early").samples[0].visible).toBe(true);
    // Soloing one picture layer hides the rest.
    const solo = text("Solo");
    (solo as any).solo = true;
    const r2 = A.legibilityRead({ comp_id: comp.id, times: [2.5] });
    expect(r2.solo_active).toBe(true);
    expect(byName(r2, "Solo").visible).toBe(true);
    expect(byName(r2, "Early").visible).toBe(false);
  });

  it("does not count a guide layer as showing", () => {
    const { project, comp, text } = scene();
    const g = text("Slate");
    g.guideLayer = true;
    const { A } = loadHost(project, ["legibility.jsx"]);
    const s = A.legibilityRead({ comp_id: comp.id, times: [1] }).layers[0].samples[0];
    expect(s).toMatchObject({ guide: true, visible: false });
  });

  it("reads layer_styles false when no style exists (the group cannot be toggled)", () => {
    const { project, comp, text } = scene();
    text("Title");
    const { A } = loadHost(project, ["legibility.jsx"]);
    expect(A.legibilityRead({ comp_id: comp.id, times: [1] }).layers[0].layer_styles).toBe(false);
  });

  it("reads layer_styles from the toggleable slots, ignoring the blend options group", () => {
    const { project, comp, text } = scene();
    const layer = text("Title") as any;
    const slot = (matchName: string, canSetEnabled: boolean, enabled: boolean) => ({ matchName, name: matchName, canSetEnabled, enabled });
    const styles: any = { matchName: "ADBE Layer Styles", name: "Layer Styles", canSetEnabled: false, props: [slot("dropShadow/enabled", true, true)] };
    styles.numProperties = 1;
    styles.property = (i: number) => styles.props[i - 1] ?? null;
    layer.group.props.push(styles);
    const { A } = loadHost(project, ["legibility.jsx"]);
    const read = () => A.legibilityRead({ comp_id: comp.id, times: [1] }).layers[0].layer_styles;
    // The group cannot be toggled: no style is applied, whatever its slots say.
    expect(read()).toBe(false);
    styles.canSetEnabled = true;
    styles.props = [slot("ADBE Blend Options Group", true, true), slot("dropShadow/enabled", true, true)];
    styles.numProperties = 2;
    expect(read()).toBe(true);
    // Only the blend options slot is on: not a style.
    styles.props = [slot("ADBE Blend Options Group", true, true), slot("dropShadow/enabled", true, false)];
    expect(read()).toBe(false);
  });

  it("gives no box to 3D text or empty text, with the reason", () => {
    const { project, comp, text } = scene();
    const flat = text("Flat");
    flat.threeDLayer = true;
    text("Empty", { left: 0, top: 0, width: 0, height: 0 });
    const { A } = loadHost(project, ["legibility.jsx"]);
    const out = A.legibilityRead({ comp_id: comp.id, times: [1] });
    const s3d = out.layers.find((l: any) => l.name === "Flat").samples[0];
    expect(s3d.box).toBeNull();
    expect(s3d.box_reason).toContain("3D");
    expect(out.layers.find((l: any) => l.name === "Empty").samples[0].box_reason).toContain("no area");
  });

  it("takes selectors, refuses a layer that is not text, and refuses bad times", () => {
    const { project, comp, text } = scene();
    text("A");
    text("B");
    const nul = comp.layers.addNull() as FakeLayer;
    const { A } = loadHost(project, ["legibility.jsx"]);
    expect(A.legibilityRead({ comp_id: comp.id, times: [1], layers: [{ name: "A" }] }).layers.map((l: any) => l.name)).toEqual(["A"]);
    expect(() => A.legibilityRead({ comp_id: comp.id, layers: [{ id: nul.id }] })).toThrow(/not a text layer/);
    expect(() => A.legibilityRead({ comp_id: comp.id, layers: [{ name: "Nope" }] })).toThrow(/No layer named/);
    expect(() => A.legibilityRead({ comp_id: comp.id, times: [-1] })).toThrow(/seconds/);
    expect(() => A.legibilityRead({ comp_id: comp.id, times: Array.from({ length: 13 }, () => 1) })).toThrow(/At most 12/);
    expect(() => A.legibilityRead({ comp_id: 99999 })).toThrow(/No CompItem/);
  });

  it("counts animators and effects, and reads a track matte", () => {
    const { project, comp, text } = scene();
    const l = text("Title");
    const tp = l.property("ADBE Text Properties") as any;
    tp.property("ADBE Text Animators").addProperty("ADBE Text Animator");
    (l.property("ADBE Effect Parade") as any).props.push({ name: "Tint" });
    l.trackMatteType = 5013;
    const { A } = loadHost(project, ["legibility.jsx"]);
    expect(A.legibilityRead({ comp_id: comp.id, times: [1] }).layers[0]).toMatchObject({ animators: 1, effects: 1, track_matte: "alpha" });
  });
});

describe("legibility.jsx writes", () => {
  const want = (l: FakeLayer) => ({ index: l.index, id: l.id, name: l.name });

  it("duplicates the comp, switches the tested text off in the copy only, in one undo group", () => {
    const { project, comp, text } = scene();
    const a = text("A");
    const b = text("B");
    allowDuplicate(project, comp);
    const { A, undo } = loadHost(project, ["legibility.jsx"]);
    const items = project.numItems;
    const out = A.legibilityBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD });
    expect(out).toMatchObject({ switched_off: 1, original_id: comp.id, comp_size: [640, 360], items_before: items });
    expect(project.numItems).toBe(items + 1);
    const copy = project.itemByID(out.copy_id) as FakeComp;
    expect(copy.name).toBe("chroma-legibility-copy Main");
    // Layer indexes are kept, and only the tested layer is off in the copy.
    expect(copy.layer(a.index)!.enabled).toBe(false);
    expect(copy.layer(b.index)!.enabled).toBe(true);
    expect(a.enabled).toBe(true);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    expect(A.legibilityState()).toEqual({ num_items: items + 1, comps: 2, temp_comps: 1 });
  });

  it("removes the copy and only a copy, and says when it is already gone", () => {
    const { project, comp, text } = scene();
    const a = text("A");
    allowDuplicate(project, comp);
    const { A, undo } = loadHost(project, ["legibility.jsx"]);
    const made = A.legibilityBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD });
    expect(() => A.legibilityEnd({ copy_id: comp.id, expect: GUARD })).toThrow(/not a legibility copy/);
    expect(project.itemByID(comp.id)).toBe(comp);
    expect(A.legibilityEnd({ copy_id: made.copy_id, expect: GUARD })).toEqual({ removed: true, copy_id: made.copy_id });
    expect(project.itemByID(made.copy_id)).toBeNull();
    expect(A.legibilityEnd({ copy_id: made.copy_id, expect: GUARD })).toMatchObject({ removed: false, already_gone: true });
    expect(undo).toMatchObject({ begun: 2, ended: 2 });
    expect(A.legibilityState().temp_comps).toBe(0);
  });

  it("validates before duplicating anything: guard, stale id, non-text, duplicates, empty and over-long lists", () => {
    const { project, comp, text } = scene();
    const a = text("A");
    const nul = comp.layers.addNull() as FakeLayer;
    allowDuplicate(project, comp);
    const { A, undo } = loadHost(project, ["legibility.jsx"]);
    const items = project.numItems;
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [want(a)], expect: { project_path: "C:/other.aep" } })).toThrow(/guard refused/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [want(a)] })).toThrow(/no expect/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [{ index: a.index, id: a.id + 500, name: "A" }], expect: GUARD })).toThrow(/not the layer read earlier/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [want(nul)], expect: GUARD })).toThrow(/not a text layer/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [want(a), want(a)], expect: GUARD })).toThrow(/listed twice/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [], expect: GUARD })).toThrow(/No text layers/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [{ index: 99, id: 1, name: "x" }], expect: GUARD })).toThrow(/out of range/);
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: Array.from({ length: 101 }, (_, i) => ({ index: i + 1, id: i, name: "x" })), expect: GUARD })).toThrow(/At most 100/);
    expect(project.numItems).toBe(items);
    expect(undo.begun).toBe(0);
  });

  it("unlocks the copy's layer before switching it off and leaves the original's lock alone", () => {
    const { project, comp, text } = scene();
    const a = text("A");
    a.locked = true;
    allowDuplicate(project, comp);
    const { A } = loadHost(project, ["legibility.jsx"]);
    const out = A.legibilityBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD });
    const copy = project.itemByID(out.copy_id) as FakeComp;
    expect(copy.layer(a.index)!.enabled).toBe(false);
    expect(a.locked).toBe(true);
    expect(a.enabled).toBe(true);
  });

  it("removes a half-made copy when the copy does not match the original", () => {
    const { project, comp, text } = scene();
    const a = text("A");
    allowDuplicate(project, comp, { renameLayers: true });
    const { A, undo } = loadHost(project, ["legibility.jsx"]);
    const items = project.numItems;
    expect(() => A.legibilityBegin({ comp_id: comp.id, layers: [want(a)], expect: GUARD })).toThrow(/not the text layer it should be/);
    expect(project.numItems).toBe(items);
    expect(a.enabled).toBe(true);
    // The undo group still closed.
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });
});

// ---------- fixes after review ----------

describe("receipt: older copies and the original's layers", () => {
  it("does not flag a copy that was already there before the run", () => {
    const before = { num_items: 5, comps: 3, temp_comps: 1 };
    expect(tempCompMismatches(before, { ...before }, null, 9)).toEqual([]);
    expect(tempCompMismatches(before, { num_items: 5, comps: 3, temp_comps: 2 }, null, 9).map((x) => x.path)).toEqual(["temp_comps"]);
  });

  it("flags a tested layer of the original that was on and is off afterwards", () => {
    const before = { num_items: 4, comps: 2, temp_comps: 0, layers: [{ id: 10, enabled: true }, { id: 11, enabled: false }] };
    expect(tempCompMismatches(before, { ...before }, null, 9)).toEqual([]);
    const after = { ...before, layers: [{ id: 10, enabled: false }, { id: 11, enabled: false }] };
    expect(tempCompMismatches(before, after, null, 9).map((x) => x.path)).toEqual(["layers.10.enabled"]);
    // A layer that was already off is not the check's doing.
    expect(tempCompMismatches({ ...before, layers: [{ id: 11, enabled: false }] }, { ...before, layers: [{ id: 11, enabled: false }] }, null, 9)).toEqual([]);
  });

  it("keeps a clean receipt with an older copy in the project, and says so", async () => {
    const { ctx } = fakeAe({ olderCopies: 1 });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(out.receipt.matches).toBe(true);
    expect(out.notes.join(" ")).toContain("already had 1 comp(s)");
  });

  it("fails the receipt when the original's text layer ended up switched off", async () => {
    const { ctx, calls } = fakeAe({ originalOffAfter: true });
    const out = (await tool("ae_check_legibility").handler(checkArgs(), ctx)) as Out;
    expect(calls.filter((c) => c.fn === "legibilityState").every((c) => c.script.includes("layer_ids"))).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt)).toContain("layers.10.enabled");
  });
});

describe("text in two colours is not passed on its dominant colour alone", () => {
  const W = 40;
  const H = 20;
  const region = { x0: 0, y0: 0, x1: W, y1: H };
  const copy = image(W, H, () => grey(40));
  const RED: Px = [120, 0, 0, 255];
  const twoColours = (redFrom: number) => image(W, H, (x, y) => (x >= 5 && x < 35 && y >= 5 && y < 15 ? (x >= redFrom ? RED : WHITE) : grey(40)));
  const judging = { required: { level: "AA" as const, largeTextPx: 24 }, tolerance: 0.1 };
  const where = { measured: "pixels" as const, compId: 1, comp: { width: W, height: H }, img: { width: W, height: H }, fixes: true, frameChanged: true };
  const layer = textLayer({ samples: [sample({ box: [0, 0, W, H] })] });

  it("reports the share of glyph pixels that are neither the dominant colour nor a blend of it", () => {
    const a = analyzeGlyphs(twoColours(23), copy, region, { sensitivity: 0.02, required: 3 });
    expect(a.text_rgb).toEqual([255, 255, 255]);
    expect(a.foreign_share).toBeGreaterThan(0.35);
    // A white block with an antialiased-looking edge column has none.
    const edged = image(W, H, (x, y) => (x >= 5 && x < 35 && y >= 5 && y < 15 ? (x === 5 ? grey(150) : WHITE) : grey(40)));
    expect(analyzeGlyphs(edged, copy, region, { sensitivity: 0.02, required: 3 }).foreign_share).toBe(0);
  });

  it("turns a pass into inconclusive when the minor colour covers a lot of the text", () => {
    const a = analyzeGlyphs(twoColours(23), copy, region, { sensitivity: 0.02, required: 3 });
    const e = judgeAnalysis(layer, layer.samples[0], a, judging, where);
    expect(e.status).toBe("inconclusive");
    expect(e.reason).toContain("different colour");
  });

  it("is stricter when the DOM says the fill is mixed, and leaves a clean single colour alone", () => {
    const small = analyzeGlyphs(twoColours(32), copy, region, { sensitivity: 0.02, required: 3 });
    expect(small.foreign_share).toBeGreaterThan(0.05);
    expect(small.foreign_share).toBeLessThan(0.3);
    expect(judgeAnalysis(layer, layer.samples[0], small, judging, where).status).toBe("pass");
    const mixed = textLayer({ samples: [sample({ box: [0, 0, W, H], mixed_fill: true })] });
    expect(judgeAnalysis(mixed, mixed.samples[0], small, judging, where).status).toBe("inconclusive");
    const single = analyzeGlyphs(twoColours(99), copy, region, { sensitivity: 0.02, required: 3 });
    expect(judgeAnalysis(mixed, mixed.samples[0], single, judging, where).status).toBe("pass");
  });

  it("still fails when the dominant colour itself fails", () => {
    const light = image(W, H, () => grey(235));
    const onLight = image(W, H, (x, y) => (x >= 5 && x < 35 && y >= 5 && y < 15 ? (x >= 23 ? RED : WHITE) : grey(235)));
    const a = analyzeGlyphs(onLight, light, region, { sensitivity: 0.02, required: 3 });
    expect(judgeAnalysis(layer, layer.samples[0], a, judging, where).status).toBe("fail");
  });
});

describe("no glyph pixels with animators or effects", () => {
  const W = 40;
  const H = 20;
  const region = { x0: 0, y0: 0, x1: W, y1: H };
  const flat = image(W, H, () => grey(40));
  const none = analyzeGlyphs(flat, flat, region, { sensitivity: 0.02, required: 3 });
  const judging = { required: { level: "AA" as const, largeTextPx: 24 }, tolerance: 0.1 };
  const where = { measured: "pixels" as const, compId: 1, comp: { width: W, height: H }, img: { width: W, height: H }, fixes: true, frameChanged: true };

  it("fails a plain layer whose box shows nothing while the frame changed elsewhere", () => {
    const l = textLayer({ samples: [sample({ box: [0, 0, W, H] })] });
    expect(judgeAnalysis(l, l.samples[0], none, judging, where).status).toBe("fail");
  });

  it("leaves it inconclusive, and says why, when animators or effects could have hidden the text", () => {
    const anim = textLayer({ animators: 1, samples: [sample({ box: [0, 0, W, H] })] });
    const e = judgeAnalysis(anim, anim.samples[0], none, judging, where);
    expect(e.status).toBe("inconclusive");
    expect(e.reason).toContain("text animators");
    const fx = textLayer({ effects: 2, samples: [sample({ box: [0, 0, W, H] })] });
    expect(judgeAnalysis(fx, fx.samples[0], none, judging, where).reason).toContain("effects");
  });
});

describe("the scrim is judged on every background pixel", () => {
  it("does not pick an opacity that only fixes the worst pixel", () => {
    // Mid-grey text on half dark and half light pixels: a black scrim helps the dark half at once
    // but drags the light half through the text's own luminance.
    const n = 40;
    const bg = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) bg.fill(i < n / 2 ? 60 : 250, i * 3, i * 3 + 3);
    const text = [128, 128, 128];
    const edgeOnly = scrimOpacity(text, [60, 60, 60], [0, 0, 0], 3)!;
    const black = scrimOpacityOver(text, bg, [0, 0, 0], 3, 0);
    expect(black === null || black > edgeOnly).toBe(true);
    // A white scrim lifts the dark half and leaves the light half passing.
    const white = scrimOpacityOver(text, bg, [255, 255, 255], 3, 0);
    expect(white).not.toBeNull();
    expect(white! % 5).toBe(0);
    expect(scrimOpacityOver(text, new Uint8Array(0), [0, 0, 0], 3, 0)).toBeNull();
  });

  it("returns null when no opacity gets all the pixels there", () => {
    const bg = new Uint8Array([0, 0, 0, 255, 255, 255]);
    expect(scrimOpacityOver([128, 128, 128], bg, [0, 0, 0], 5.5, 0)).toBeNull();
    expect(scrimOpacityOver([128, 128, 128], bg, [255, 255, 255], 5.5, 0)).toBeNull();
  });
});

describe("layers past the 100 cap", () => {
  it("appear in the output under untested, with the reason, and count as inconclusive", async () => {
    const many = Array.from({ length: 103 }, (_, i) => textLayer({ index: i + 1, id: i + 1, name: `T${i + 1}`, samples: [sample({ box: [0, 0, 5, 5] })] }));
    const { ctx } = fakeAe({ read: readOf(many), bg: 20 });
    const out = (await tool("ae_check_legibility").handler(checkArgs({ annotate: false }), ctx)) as Out;
    expect(out.untested.map((e: Out) => e.layer.name)).toEqual(["T101", "T102", "T103"]);
    expect(out.untested[0]).toMatchObject({ status: "inconclusive", reason: expect.stringContaining("only 100 text layers are tested") });
    expect(out.untested_truncated).toBeUndefined();
    expect(out.checked).toBe(103);
  });
});

describe("legibility.jsx state with layers", () => {
  it("lists whether the tested layers of the original comp are switched on", () => {
    const { project, comp, text } = scene();
    const a = text("A");
    const b = text("B");
    b.enabled = false;
    const { A } = loadHost(project, ["legibility.jsx"]);
    const st = A.legibilityState({ comp_id: comp.id, layer_ids: [a.id, b.id] });
    expect(st.layers).toEqual([
      { id: a.id, enabled: true },
      { id: b.id, enabled: false },
    ].sort((x, y) => comp.stack.findIndex((l: any) => l.id === x.id) - comp.stack.findIndex((l: any) => l.id === y.id)));
    expect(A.legibilityState().layers).toBeUndefined();
  });
});
