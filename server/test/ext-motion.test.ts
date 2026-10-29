import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { zodToJsonSchema } from "../src/schema.js";
import {
  AeContactSheetSchema,
  AeMotionGraphSchema,
  AeMotionReviewSchema,
  analyzeMotion,
  buildContactSheet,
  chooseColumns,
  contactSheetTimes,
  fixEase,
  formatNumber,
  frameLabel,
  MAX_SHEET_EDGE,
  motionTools,
  type PropertyKey,
  type PropertySamples,
  renderMotionGraph,
  reviewProperty,
  sampleSpeeds,
  segmentProfile,
  sortFindings,
  sheetLayout,
} from "../src/tools/ext/motion.js";
import { fitWithin, resizeArea, textWidth } from "../src/tools/ext/png-utils.js";
import { AeSnapshotFrameSchema, renderTools } from "../src/tools/render.js";

function solidPng(width: number, height: number, rgba: [number, number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return png;
}

function writePng(filePath: string, png: PNG): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function key(index: number, time: number, value: number[], outInterp = "bezier"): PropertyKey {
  return { index, time, value, in_interp: "bezier", out_interp: outInterp };
}

/** Samples `fn` once per frame from `start` to `end`, the way sampleProperty does. */
function samplesOf(
  fn: (t: number) => number[],
  keys: PropertyKey[],
  opts: { start?: number; end?: number; fps?: number; spatial?: boolean } = {}
): PropertySamples {
  const fps = opts.fps ?? 25;
  const start = opts.start ?? keys[0].time;
  const end = opts.end ?? keys[keys.length - 1].time;
  const times: number[] = [];
  for (let i = 0; start + i / fps <= end + 1e-9; i++) times.push(start + i / fps);
  const values = times.map(fn);
  return {
    comp: { id: 7, name: "Shot", fps },
    layer: { index: 1, id: 11, name: "Ball" },
    property: {
      name: "Position",
      matchName: "ADBE Position",
      value_type: "TwoD_SPATIAL",
      spatial: opts.spatial ?? true,
      dimensions: values[0].length,
      num_keys: keys.length,
      keys_truncated: false,
      samples_capped: false,
      expression: false,
    },
    start,
    end,
    step: 1 / fps,
    times,
    values,
    keys,
  };
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function pixel(png: PNG, x: number, y: number): number[] {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

describe("ext/png-utils", () => {
  it("fits within a long edge without upscaling", () => {
    expect(fitWithin(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
    expect(fitWithin(1080, 1920, 320)).toEqual({ width: 180, height: 320 });
    expect(fitWithin(100, 50, 320)).toEqual({ width: 100, height: 50 });
  });

  it("averages areas in premultiplied alpha, so transparent pixels don't darken edges", () => {
    const src = new PNG({ width: 2, height: 1 });
    src.data.set([255, 0, 0, 255, 0, 0, 0, 0]);
    const out = resizeArea(src, 1, 1);
    expect(pixel(out, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it("shrinks by non-integer ratios with exact area weights", () => {
    // 3 px -> 2 px: each output pixel covers 1.5 source pixels.
    const src = new PNG({ width: 3, height: 1 });
    src.data.set([0, 0, 0, 255, 90, 90, 90, 255, 180, 180, 180, 255]);
    const out = resizeArea(src, 2, 1);
    expect(pixel(out, 0, 0)).toEqual([30, 30, 30, 255]);
    expect(pixel(out, 1, 0)).toEqual([150, 150, 150, 255]);
  });

  it("measures label text", () => {
    expect(textWidth("f12", 2)).toBe((3 * 6 - 1) * 2);
    expect(textWidth("", 2)).toBe(0);
  });
});

describe("ext/motion contact sheet logic", () => {
  const comp = { fps: 25, duration: 5, workAreaStart: 0, workAreaDuration: 5 };

  it("samples the work area evenly on the frame grid, first and last frame included", () => {
    const samples = contactSheetTimes(comp, {});
    expect(samples).toHaveLength(12);
    expect(samples[0]).toEqual({ frame: 0, time: 0 });
    expect(samples[11]).toEqual({ frame: 124, time: 4.96 });
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].frame).toBeGreaterThan(samples[i - 1].frame);
    }
  });

  it("uses the work area by default and respects start/end/count", () => {
    const wa = contactSheetTimes({ ...comp, workAreaStart: 1, workAreaDuration: 2 }, { count: 3 });
    expect(wa.map((s) => s.frame)).toEqual([25, 50, 74]);
    const range = contactSheetTimes(comp, { start: 2, end: 3, count: 2 });
    expect(range.map((s) => s.frame)).toEqual([50, 74]);
  });

  it("returns fewer frames than `count` when the range is short", () => {
    const samples = contactSheetTimes(comp, { start: 0, end: 0.2, count: 12 });
    expect(samples.map((s) => s.frame)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps explicit times and rejects times past the comp's end", () => {
    expect(contactSheetTimes(comp, { times: [0.5, 1] })).toEqual([
      { time: 0.5, frame: 13 },
      { time: 1, frame: 25 },
    ]);
    expect(() => contactSheetTimes(comp, { times: [1, 6] })).toThrow(/past the comp's duration/);
  });

  it("rejects mixing explicit times with a range", () => {
    expect(AeContactSheetSchema.safeParse({ comp_id: 1, times: [0, 1], count: 4 }).success).toBe(false);
    expect(AeContactSheetSchema.safeParse({ comp_id: 1, start: 2, end: 1 }).success).toBe(false);
    expect(AeContactSheetSchema.safeParse({ comp_id: 1, count: 25 }).success).toBe(false);
    expect(AeContactSheetSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(zodToJsonSchema(AeContactSheetSchema)).toMatchObject({ type: "object" });
  });

  it("lays out roughly 16:9 sheets and keeps them under the size cap", () => {
    expect(chooseColumns(12, 320, 180)).toBe(3);
    const landscape = sheetLayout(12, 1920, 1080, 320);
    expect(landscape).toMatchObject({ tileWidth: 320, tileHeight: 180, columns: 3, rows: 4 });

    const big = sheetLayout(24, 1080, 1920, 768);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(MAX_SHEET_EDGE);
    expect(big.columns * big.rows).toBeGreaterThanOrEqual(24);
  });

  it("draws tiles, labels and a red border on flagged frames", () => {
    const layout = sheetLayout(2, 64, 36, 64, 2);
    const sheet = buildContactSheet(
      [
        { image: solidPng(64, 36, [0, 128, 255, 255]), label: frameLabel({ frame: 0, time: 0 }), flagged: false },
        { image: solidPng(64, 36, [0, 0, 0, 0]), label: "f1 0.04s", flagged: true },
      ],
      layout
    );
    expect(sheet.width).toBe(layout.width);
    expect(sheet.height).toBe(layout.height);
    // Tile 1 centre is the solid colour; its top-left corner is not red.
    expect(pixel(sheet, 6 + 32, 6 + 10)).toEqual([0, 128, 255, 255]);
    expect(pixel(sheet, 6, 6)).not.toEqual([230, 40, 40, 255]);
    // The label strip sits under the tile: the tile's bottom row is untouched.
    expect(layout.labelHeight).toBeGreaterThan(0);
    expect(pixel(sheet, 6 + 32, 6 + 35)).toEqual([0, 128, 255, 255]);
    expect(pixel(sheet, 6 + 60, 6 + 36 + 2)).toEqual([0, 0, 0, 255]);
    expect(layout.height).toBe(36 + layout.labelHeight + 2 * 6);
    // Tile 2 is flagged: red border.
    const x2 = 6 + 64 + 6;
    expect(pixel(sheet, x2, 6)).toEqual([230, 40, 40, 255]);
  });
});

describe("ext/motion graph logic", () => {
  it("measures speed between samples and drops the jump after a hold key", () => {
    const linear = sampleSpeeds(samplesOf((t) => [100 * t, 0], [key(1, 0, [0, 0]), key(2, 1, [100, 0])]));
    expect(linear).toHaveLength(25);
    for (const sp of linear) expect(sp.speed).toBeCloseTo(100, 6);

    // Hold on key 1 until 0.5s, then linear to key 3. Sampled at 10 fps.
    const held = sampleSpeeds(
      samplesOf(
        (t) => [t < 0.5 - 1e-9 ? 0 : 10 + 20 * (t - 0.5)],
        [key(1, 0, [0], "hold"), key(2, 0.5, [10]), key(3, 1, [20])],
        { fps: 10 }
      )
    );
    expect(held[3].speed).toBe(0);
    expect(held[4].speed).toBeNull();
    expect(held[5].speed).toBeCloseTo(20, 6);
  });

  it("names speed profiles between keys", () => {
    expect(segmentProfile(0, 0, 150, false)).toBe("ease in-out");
    expect(segmentProfile(100, 100, 100, false)).toBe("constant");
    expect(segmentProfile(5, 95, 100, false)).toBe("speeds up");
    expect(segmentProfile(95, 5, 100, false)).toBe("slows down");
    expect(segmentProfile(60, 60, 100, false)).toBe("uneven");
    expect(segmentProfile(0, 0, 0, false)).toBe("static");
    expect(segmentProfile(0, 0, 0, true)).toBe("hold");
  });

  it("summarises an eased move followed by a linear one", () => {
    const s = samplesOf(
      (t) => (t <= 1 ? [100 * smoothstep(t), 0] : [100, 100 * (t - 1)]),
      [key(1, 0, [0, 0]), key(2, 1, [100, 0]), key(3, 2, [100, 100])]
    );
    const a = analyzeMotion(s, sampleSpeeds(s));
    expect(a.segments.map((g) => g.profile)).toEqual(["ease in-out", "constant"]);
    expect(a.segments[0].peak_at).toBeCloseTo(0.5, 1);
    expect(a.segments[0].distance).toBeCloseTo(100, 0);
    expect(a.segments[1].peak_speed).toBeCloseTo(100, 3);
    // Smoothstep peaks at 1.5x the average speed.
    expect(a.speed.peak).toBeCloseTo(150, 0);
    expect(a.speed.peak_time).toBeCloseTo(0.5, 1);
    expect(a.distance).toBeCloseTo(200, 0);
    expect(a.value).toMatchObject({ start: [0, 0], end: [100, 100], min: [0, 0], max: [100, 100] });
    expect(a.overshoot).toEqual([]);

    const held = samplesOf(() => [5], [key(1, 0, [5], "hold"), key(2, 1, [5])], { spatial: false });
    const heldSegment = analyzeMotion(held, sampleSpeeds(held)).segments[0];
    expect(heldSegment).toMatchObject({ profile: "hold", distance: 0, peak_at: null });
  });

  it("reports overshoot past the keyframe values", () => {
    const s = samplesOf(
      (t) => [t <= 1 ? 90 * t : 90 + 20 * Math.sin(2 * Math.PI * (t - 1)) * Math.exp(-3 * (t - 1))],
      [key(1, 0, [0]), key(2, 1, [90])],
      { end: 1.5, spatial: false }
    );
    const a = analyzeMotion(s, sampleSpeeds(s));
    expect(a.overshoot).toHaveLength(1);
    expect(a.overshoot[0].dimension).toBe(0);
    expect(a.overshoot[0].below_keys_by).toBe(0);
    expect(a.overshoot[0].above_keys_by).toBeGreaterThan(5);
  });

  it("formats axis labels without exponents", () => {
    expect(formatNumber(1234.5)).toBe("1235");
    expect(formatNumber(512.34)).toBe("512.3");
    expect(formatNumber(3.14159)).toBe("3.14");
    expect(formatNumber(0.5)).toBe("0.500");
    expect(formatNumber(-42)).toBe("-42.00");
  });

  it("draws value curves, keyframe dots and the speed line", () => {
    const s = samplesOf(
      (t) => [100 * smoothstep(t), 40],
      [key(1, 0, [0, 40]), key(2, 1, [100, 40])]
    );
    const png = renderMotionGraph(s, sampleSpeeds(s), 400, 300);
    expect(png.width).toBe(400);
    expect(png.height).toBe(300);
    const count = (rgb: number[]) => {
      let n = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1] && png.data[i + 2] === rgb[2]) n++;
      }
      return n;
    };
    expect(count([235, 80, 80])).toBeGreaterThan(100); // X curve
    expect(count([90, 200, 90])).toBeGreaterThan(100); // Y curve
    expect(count([240, 240, 240])).toBeGreaterThan(100); // speed
    expect(count([255, 200, 60])).toBeGreaterThan(20); // key dots and #n labels

    // A flat property and a hold jump still render.
    const flat = samplesOf(() => [5], [key(1, 0, [5], "hold"), key(2, 1, [5])], { spatial: false });
    expect(renderMotionGraph(flat, sampleSpeeds(flat), 320, 200).width).toBe(320);
  });

  it("rejects an empty range in the schema", () => {
    const base = { comp_id: 1, layer: { index: 1 }, path: ["ADBE Opacity"] };
    expect(AeMotionGraphSchema.safeParse({ ...base, start: 2, end: 1 }).success).toBe(false);
    expect(AeMotionGraphSchema.safeParse({ ...base, path: [] }).success).toBe(false);
    expect(AeMotionGraphSchema.safeParse(base).success).toBe(true);
    expect(zodToJsonSchema(AeMotionGraphSchema)).toMatchObject({ type: "object" });
  });
});

describe("ext/motion tools against a fake AE", () => {
  const tmpDirs: string[] = [];
  const written: string[] = [];
  const origLocalAppData = process.env.LOCALAPPDATA;

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-motion-"));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    process.env.LOCALAPPDATA = makeTempDir();
  });

  afterEach(() => {
    if (origLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = origLocalAppData;
    }
    // On macOS the data dir ignores LOCALAPPDATA, so remove what the tools wrote.
    for (const f of written.splice(0)) fs.rmSync(f, { force: true });
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fakeHost(onSnapshot: (index: number, outPath: string) => void) {
    const dir = makeTempDir();
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const scripts: string[] = [];
    let snapIndex = 0;
    const host = new PanelHost({
      evalScript: async (script) => {
        scripts.push(script);
        if (script.includes("__chromaAe.getComp(")) {
          return {
            ok: true,
            result: {
              id: 7,
              name: "Shot",
              width: 64,
              height: 36,
              fps: 25,
              duration: 2,
              workAreaStart: 0,
              workAreaDuration: 2,
            },
            durationMs: 1,
          };
        }
        const m = /"output_path":"([^"]+)"/.exec(script);
        const outPath = JSON.parse(`"${m![1]}"`) as string;
        onSnapshot(snapIndex++, outPath);
        written.push(outPath);
        return { ok: true, result: { path: outPath, width: 64, height: 36 }, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    return { host, queue, quarantine, scripts };
  }

  it("ae_contact_sheet samples the work area, tiles the frames and flags a transparent one", async () => {
    const { host, queue, quarantine, scripts } = fakeHost((i, outPath) => {
      if (i === 0) {
        writePng(outPath, solidPng(64, 36, [0, 0, 0, 0]));
        return;
      }
      // Two colours, so the frame isn't "uniform" (which counts as blank).
      const png = solidPng(64, 36, [20, 20, 20, 255]);
      for (let y = 0; y < 36; y++) {
        for (let x = i * 10; x < i * 10 + 12; x++) png.data.set([255, 120, 0, 255], (y * 64 + x) * 4);
      }
      writePng(outPath, png);
    });
    const tool = motionTools.find((t) => t.name === "ae_contact_sheet")!;
    const res = (await tool.handler(AeContactSheetSchema.parse({ comp_id: 7, count: 4 }), {
      bridge: host,
      queue,
      quarantine,
    })) as Record<string, any>;
    written.push(res.path);

    expect(scripts[0]).toContain("__chromaAe.getComp(");
    expect(scripts.filter((s) => s.includes("__chromaAe.snapshotFrame("))).toHaveLength(4);
    expect(res.ok).toBe(true);
    expect(res.frames.map((f: any) => f.frame)).toEqual([0, 16, 33, 49]);
    expect(res.flagged_frames).toHaveLength(1);
    expect(res.flagged_frames[0].index).toBe(0);
    expect(res.flagged_frames[0].flags).toContain("transparent");

    const sheet = PNG.sync.read(fs.readFileSync(res.path));
    expect(sheet.width).toBe(res.width);
    expect(sheet.height).toBe(res.height);
    expect(res.columns * res.rows).toBeGreaterThanOrEqual(4);
  });

  it("ae_snapshot_frame shrinks on the server and keeps the full-size render", async () => {
    const { host, queue, quarantine } = fakeHost((_i, outPath) => {
      writePng(outPath, solidPng(100, 50, [10, 20, 30, 255]));
    });
    const tool = renderTools.find((t) => t.name === "ae_snapshot_frame")!;
    const ctx = { bridge: host, queue, quarantine };

    const half = (await tool.handler(AeSnapshotFrameSchema.parse({ comp_id: 7, time: 0 }), ctx)) as Record<string, any>;
    written.push(half.path);
    expect(half.ok).toBe(true);
    expect(half).toMatchObject({ width: 50, height: 25, scale: 0.5, comp_width: 64, comp_height: 36 });
    expect(half.path).not.toBe(half.full_path);
    expect(PNG.sync.read(fs.readFileSync(half.path)).width).toBe(50);
    expect(PNG.sync.read(fs.readFileSync(half.full_path)).width).toBe(100);

    const capped = (await tool.handler(
      AeSnapshotFrameSchema.parse({ comp_id: 7, time: 0, max_size: 20 }),
      ctx
    )) as Record<string, any>;
    written.push(capped.path);
    expect(capped).toMatchObject({ width: 20, height: 10, max_size: 20 });

    const full = (await tool.handler(AeSnapshotFrameSchema.parse({ comp_id: 7, time: 0, scale: 1 }), ctx)) as Record<string, any>;
    expect(full.path).toBe(full.full_path);
    expect(full).toMatchObject({ width: 100, height: 50 });
  });

  it("ae_motion_graph samples through sampleProperty, draws the graph and summarises it", async () => {
    const dir = makeTempDir();
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const scripts: string[] = [];
    const sampled = samplesOf((t) => [100 * smoothstep(t), 50], [key(1, 0, [0, 50]), key(2, 1, [100, 50])]);
    const host = new PanelHost({
      evalScript: async (script) => {
        scripts.push(script);
        return { ok: true, result: sampled, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const tool = motionTools.find((t) => t.name === "ae_motion_graph")!;
    const res = (await tool.handler(
      AeMotionGraphSchema.parse({
        comp_id: 7,
        layer: { name: "Ball" },
        path: ["Transform", "Position"],
        width: 480,
        height: 270,
        include_samples: true,
      }),
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;
    written.push(res.path);

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("__chromaAe.sampleProperty(");
    expect(scripts[0]).toContain('"path":["Transform","Position"]');
    expect(scripts[0]).not.toContain('"start"');
    expect(res.ok).toBe(true);
    expect(res.speed.unit).toBe("px/s");
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0].profile).toBe("ease in-out");
    expect(res.samples).toBe(sampled.times.length);
    expect(res.sample_table).toHaveLength(sampled.times.length);
    expect(res.sample_table[res.sample_table.length - 1].speed_after).toBeNull();
    const png = PNG.sync.read(fs.readFileSync(res.path));
    expect([png.width, png.height]).toEqual([480, 270]);
  });
});

describe("panel/host/ext/motion.jsx sampleProperty in a simulated AE DOM", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../panel/host/ext/motion.jsx"), "utf8");

  function simulatedAe(opts: { threeDLayer: boolean; numKeys?: number }) {
    class CompItem {}
    const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };
    const PropertyValueType = { OneD: 1, TwoD: 2, TwoD_SPATIAL: 3, ThreeD: 4, ThreeD_SPATIAL: 5, COLOR: 6, NO_VALUE: 7 };
    const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
    const keyTimes = [0.5, 1.5];
    const valueAt = (t: number) => [100 + 100 * t, 50, 0];
    const preExpressionArgs: boolean[] = [];
    const position = {
      name: "Position",
      matchName: "ADBE Position",
      propertyType: PropertyType.PROPERTY,
      propertyValueType: PropertyValueType.ThreeD_SPATIAL,
      numKeys: opts.numKeys ?? 2,
      keyTime: (k: number) => keyTimes[k - 1],
      keyValue: (k: number) => valueAt(keyTimes[k - 1]),
      keyInInterpolationType: () => KeyframeInterpolationType.LINEAR,
      keyOutInterpolationType: (k: number) =>
        k === 1 ? KeyframeInterpolationType.HOLD : KeyframeInterpolationType.BEZIER,
      keyInTemporalEase: () => [{ speed: 0, influence: 33.33 }],
      keyOutTemporalEase: () => [{ speed: 0, influence: 33.33 }],
      valueAtTime: (t: number, preExpression: boolean) => {
        preExpressionArgs.push(preExpression);
        return valueAt(t);
      },
      canSetExpression: true,
      expressionEnabled: false,
      expression: "",
    };
    const transform = {
      property: (n: string) => (n === "ADBE Position" || n === "Position" ? position : null),
    };
    const layer = {
      index: 1,
      id: 11,
      name: "Ball",
      threeDLayer: opts.threeDLayer,
      property: (n: string) => (n === "ADBE Transform Group" || n === "Transform" ? transform : null),
    };
    let timeWrites = 0;
    const comp = Object.assign(new CompItem(), {
      id: 5,
      name: "Shot",
      frameRate: 25,
      numLayers: 1,
      workAreaStart: 0,
      workAreaDuration: 2,
      layer: (sel: number | string) => (sel === 1 || sel === "Ball" ? layer : null),
    });
    Object.defineProperty(comp, "time", {
      get: () => 0,
      set: () => {
        timeWrites++;
      },
    });
    // Array comes from this realm so the values built here pass `instanceof Array`.
    const G: Record<string, any> = {
      __chromaAe: {},
      Array,
      CompItem,
      PropertyType,
      PropertyValueType,
      KeyframeInterpolationType,
      app: { project: { itemByID: (id: number) => (id === 5 ? comp : null) } },
    };
    G.$ = { global: G };
    vm.runInNewContext(source, G);
    return { A: G.__chromaAe, preExpressionArgs, timeWrites: () => timeWrites };
  }

  const args = { comp_id: 5, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Position"] };

  it("samples between the first and last keys, with expressions applied, without moving the comp's time", () => {
    const { A, preExpressionArgs, timeWrites } = simulatedAe({ threeDLayer: true });
    const res = A.sampleProperty(args);
    expect(res.start).toBe(0.5);
    expect(res.end).toBe(1.5);
    expect(res.times).toHaveLength(26);
    expect(res.values[0]).toEqual([150, 50, 0]);
    expect(res.property).toMatchObject({ value_type: "ThreeD_SPATIAL", spatial: true, dimensions: 3, num_keys: 2 });
    expect(res.keys.map((k: any) => k.out_interp)).toEqual(["hold", "bezier"]);
    expect(res.keys[0].in_ease).toEqual([{ speed: 0, influence: 33.33 }]);
    expect(preExpressionArgs.every((p) => p === false)).toBe(true);
    expect(timeWrites()).toBe(0);
  });

  it("drops the constant Z of Position on a 2D layer", () => {
    const { A } = simulatedAe({ threeDLayer: false });
    const res = A.sampleProperty(args);
    expect(res.property.dimensions).toBe(2);
    expect(res.values[0]).toEqual([150, 50]);
    expect(res.keys[1].value).toEqual([250, 50]);
  });

  it("uses the work area without keys and caps the sample count", () => {
    const { A } = simulatedAe({ threeDLayer: false, numKeys: 0 });
    const res = A.sampleProperty({ ...args, step: 0.0001 });
    expect(res.start).toBe(0);
    expect(res.end).toBe(2);
    expect(res.times.length).toBeLessThanOrEqual(1000);
    expect(res.times[res.times.length - 1]).toBeCloseTo(2, 9);
  });

  it("rejects missing properties and empty ranges", () => {
    const { A } = simulatedAe({ threeDLayer: false });
    expect(() => A.sampleProperty({ ...args, path: ["ADBE Transform Group", "Nope"] })).toThrow(/not found/);
    expect(() => A.sampleProperty({ ...args, start: 1, end: 1 })).toThrow(/Empty range/);
  });
});

describe("ext/motion review rules", () => {
  const target = { comp_id: 7, project_path: "C:/jobs/Shot.aep" };
  const POS = ["ADBE Transform Group", "ADBE Position"];
  const review = (s: PropertySamples, propPath = POS) => reviewProperty(s, analyzeMotion(s, sampleSpeeds(s)), propPath, target);
  const named = (s: PropertySamples, name: string, matchName: string, spatial = false): PropertySamples => ({
    ...s,
    property: { ...s.property, name, matchName, spatial },
  });

  it("flags a linear move once, easing only its ends, with a ready ae_set_keyframe_ease call", () => {
    // Two linear segments at the same speed: one continuous move from key 1 to key 3.
    const s = samplesOf((t) => [100 * t, 0], [key(1, 0, [0, 0], "linear"), key(2, 1, [100, 0], "linear"), key(3, 2, [200, 0], "linear")]);
    const f = review(s);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "linear", severity: "medium", keys: [1, 3], time: 0 });
    expect(f[0].message).toMatch(/constant speed \(100\.0 px\/s\) from key 1 to key 3/);
    expect(f[0].message).toMatch(/The key in between keeps its linear speed.*roving/);
    expect(f[0].fix).toEqual({
      tool: "ae_set_keyframe_ease",
      args: {
        comp_id: 7,
        layer: { id: 11 },
        path: POS,
        keys: [1, 3],
        ease: "easy_ease",
        expect: { project_path: "C:/jobs/Shot.aep", comp_id: 7 },
      },
    });
  });

  it("keeps a key between frames from blending two linear segments (measured on AE 26.2.1)", () => {
    // 160 px/s to key 2 at 1.5s (frame 37.5), then 240 px/s. The interval
    // 1.48-1.52s straddles the key and measures 200 px/s.
    const s = samplesOf(
      (t) => (t <= 1.5 ? [80 + 160 * t, 240] : [320 + 240 * (t - 1.5), 240]),
      [key(1, 0, [80, 240], "linear"), key(2, 1.5, [320, 240], "linear"), key(3, 2.5, [560, 240], "linear")],
      { end: 2.5 }
    );
    const a = analyzeMotion(s, sampleSpeeds(s));
    expect(a.segments.map((g) => [g.profile, g.start_speed, g.end_speed])).toEqual([
      ["constant", 160, 160],
      ["constant", 240, 240],
    ]);
    const kinds = review(s).map((x) => x.kind).sort();
    expect(kinds).toEqual(["linear", "linear", "subframe_key"]);
  });

  it("leaves an eased move alone", () => {
    expect(review(samplesOf((t) => [100 * smoothstep(t), 0], [key(1, 0, [0, 0]), key(2, 1, [100, 0])]))).toEqual([]);
  });

  it("rates a linear opacity fade low, since fades are often linear on purpose", () => {
    const s = named(samplesOf((t) => [100 * t], [key(1, 0, [0], "linear"), key(2, 1, [100], "linear")], { spatial: false }), "Opacity", "ADBE Opacity");
    const f = review(s, ["ADBE Transform Group", "ADBE Opacity"]);
    expect(f.map((x) => [x.kind, x.severity])).toEqual([["linear", "low"]]);
    expect(f[0].message).toMatch(/100\.0 \/s/);
  });

  it("flags motion that starts or stops at full speed", () => {
    // Ease-out shape: fastest at key 1, settles into key 2.
    const startsFast = review(samplesOf((t) => [100 * (1 - (1 - t) ** 2), 0], [key(1, 0, [0, 0]), key(2, 1, [100, 0])]));
    expect(startsFast.map((x) => [x.kind, x.keys])).toEqual([["abrupt_start", [1]]]);
    expect(startsFast[0].fix?.args.keys).toEqual([1]);

    // Ease-in shape: fastest as it hits key 2.
    const stopsDead = review(samplesOf((t) => [100 * t * t, 0], [key(1, 0, [0, 0]), key(2, 1, [100, 0])]));
    expect(stopsDead.map((x) => [x.kind, x.keys])).toEqual([["abrupt_stop", [2]]]);
    expect(stopsDead[0].message).toMatch(/stops dead at key 2/);
  });

  it("flags a jolt at a key where a stop hands over to a fast move", () => {
    // Eases to a stop at key 2 (1s), then leaves it at full linear speed.
    const s = samplesOf(
      (t) => (t <= 1 ? [50 * (1 - (1 - t) ** 2), 0] : [50 + 100 * (t - 1), 0]),
      [key(1, 0, [0, 0]), key(2, 1, [50, 0], "linear"), key(3, 2, [150, 0], "linear")]
    );
    const f = review(s);
    const jump = f.find((x) => x.kind === "speed_jump")!;
    expect(jump).toMatchObject({ severity: "medium", keys: [2], time: 1 });
    expect(jump.fix?.args.keys).toEqual([2]);
    expect(f.map((x) => x.kind).sort()).toEqual(["abrupt_start", "linear", "speed_jump"]);
  });

  it("gives no fix for a jump between two fast speeds, since easing the key would add a stop", () => {
    const s = samplesOf(
      (t) => (t <= 1 ? [100 * t, 0] : [100 + 400 * (t - 1), 0]),
      [key(1, 0, [0, 0], "linear"), key(2, 1, [100, 0], "linear"), key(3, 2, [500, 0], "linear")]
    );
    const jump = review(s).find((x) => x.kind === "speed_jump")!;
    expect(jump.fix).toBeUndefined();
    expect(jump.message).toMatch(/Match the speeds/);
  });

  it("notes overshoot as info, at the time it peaks", () => {
    const s = named(
      samplesOf(
        (t) => [t <= 1 ? 90 * smoothstep(t) : 90 + 20 * Math.sin(2 * Math.PI * (t - 1)) * Math.exp(-3 * (t - 1))],
        [key(1, 0, [0]), key(2, 1, [90])],
        { end: 1.5, spatial: false }
      ),
      "Rotation",
      "ADBE Rotate Z"
    );
    const over = review(s, ["ADBE Transform Group", "ADBE Rotate Z"]).find((x) => x.kind === "overshoot")!;
    expect(over.severity).toBe("info");
    expect(over.time).toBeGreaterThan(1);
    expect(over.time).toBeLessThan(1.3);
    expect(over.fix).toBeUndefined();
  });

  it("flags keys between frames, once per property", () => {
    const s = samplesOf((t) => [100 * smoothstep(Math.min(1, t / 0.5)), 0], [key(1, 0, [0, 0]), key(2, 0.5, [100, 0])], { end: 0.52 });
    const sub = review(s).filter((x) => x.kind === "subframe_key");
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({ severity: "low", keys: [2] });
    expect(sub[0].message).toBe(
      "Key 2 of Position sits between frames (frame 12.50), so no rendered frame lands on it. Move it to frame 13."
    );

    const two = samplesOf((t) => [100 * smoothstep(Math.min(1, Math.max(0, t - 0.5)))], [key(1, 0.5, [0]), key(2, 1.5, [100])], { start: 0.5, end: 1.5 });
    const grouped = review(two).filter((x) => x.kind === "subframe_key");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].keys).toEqual([1, 2]);
    expect(grouped[0].message).toMatch(/^Keys 1 and 2 of Position sit between frames \(frame 12\.50 and 37\.50\).*Move them to frame 13 and 38\.$/);
  });

  it("does not call a key a dead stop when an expression keeps it moving, and reports the overshoot", () => {
    // Speeds up into key 2, then an expression settle carries the motion on (sampled past the key).
    const s = named(
      samplesOf(
        (t) => [t <= 1 ? 90 * t * t : 90 + 15 * Math.sin(10 * (t - 1)) * Math.exp(-3 * (t - 1))],
        [key(1, 0, [0]), key(2, 1, [90])],
        { end: 2, spatial: false }
      ),
      "Rotation",
      "ADBE Rotate Z"
    );
    const kinds = review(s, ["ADBE Transform Group", "ADBE Rotate Z"]).map((x) => x.kind);
    expect(kinds).not.toContain("abrupt_stop");
    expect(kinds).toContain("overshoot");
  });

  describe("following the user's taste (ae_taste)", () => {
    const linearMove = () => samplesOf((t) => [100 * t, 0], [key(1, 0, [0, 0], "linear"), key(2, 1, [100, 0], "linear")]);

    it("fixes with the preferred curve's handle lengths at zero speed", () => {
      expect(fixEase(undefined)).toEqual({ ease: "easy_ease", name: "Easy ease" });
      expect(fixEase({ preferred_ease: [0.2, 0, 0, 1] })).toEqual({
        ease: { in: { speed: 0, influence: 100 }, out: { speed: 0, influence: 20 } },
        name: "Your preferred ease",
      });
      const f = reviewProperty(linearMove(), analyzeMotion(linearMove(), sampleSpeeds(linearMove())), POS, target, {
        preferred_ease: [0.4, 0, 0.3, 1],
      });
      expect(f[0].fix!.args.ease).toEqual({ in: { speed: 0, influence: 70 }, out: { speed: 0, influence: 40 } });
      expect(f[0].message).toMatch(/Your preferred ease on keys 1 and 2/);
    });

    it("leaves linear opacity alone when the user says it is on purpose, but still flags position", () => {
      const fade = named(samplesOf((t) => [100 - 100 * t], [key(1, 0, [100], "linear"), key(2, 1, [0], "linear")], { spatial: false }), "Opacity", "ADBE Opacity");
      const withTaste = (s: PropertySamples, p: string[]) =>
        reviewProperty(s, analyzeMotion(s, sampleSpeeds(s)), p, target, { allow_linear_non_motion: true });
      expect(review(fade, ["ADBE Transform Group", "ADBE Opacity"]).some((x) => x.kind === "linear")).toBe(true);
      expect(withTaste(fade, ["ADBE Transform Group", "ADBE Opacity"])).toEqual([]);
      expect(withTaste(linearMove(), POS).map((x) => x.kind)).toContain("linear");
    });

    it("reports overshoot as low when the user wants none", () => {
      const s = named(
        samplesOf(
          (t) => [t <= 1 ? 90 * smoothstep(t) : 90 + 20 * Math.sin(2 * Math.PI * (t - 1)) * Math.exp(-3 * (t - 1))],
          [key(1, 0, [0]), key(2, 1, [90])],
          { end: 1.5, spatial: false }
        ),
        "Rotation",
        "ADBE Rotate Z"
      );
      const over = reviewProperty(s, analyzeMotion(s, sampleSpeeds(s)), ["ADBE Transform Group", "ADBE Rotate Z"], target, {
        avoid_overshoot: true,
      }).find((x) => x.kind === "overshoot")!;
      expect(over.severity).toBe("low");
      expect(over.message).toMatch(/prefers no overshoot/);
    });
  });

  it("sorts by severity, then layer, then time", () => {
    const f = (severity: "medium" | "low" | "info", index: number, time: number) =>
      ({ severity, layer: { index, id: index, name: "" }, time }) as any;
    const sorted = sortFindings([f("info", 1, 0), f("low", 1, 0), f("medium", 2, 0), f("medium", 1, 2), f("medium", 1, 1)]);
    expect(sorted.map((x) => `${x.severity}:${x.layer.index}:${x.time}`)).toEqual([
      "medium:1:1",
      "medium:1:2",
      "medium:2:0",
      "low:1:0",
      "info:1:0",
    ]);
  });
});

describe("ae_motion_review against a fake AE", () => {
  it("lists the animated properties, samples each one, and returns sorted findings with fixes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-review-"));
    try {
      const queue = new SingleWriterQueue();
      const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
      const linear = samplesOf((t) => [100 * t, 0], [key(1, 0, [0, 0], "linear"), key(2, 1, [100, 0], "linear")]);
      const eased = {
        ...samplesOf((t) => [100 * smoothstep(t)], [key(1, 0, [0]), key(2, 1, [100])], { spatial: false }),
        layer: { index: 2, id: 22, name: "Logo" },
      };
      eased.property = { ...eased.property, name: "Scale", matchName: "ADBE Scale" };
      const scripts: string[] = [];
      const host = new PanelHost({
        evalScript: async (script) => {
          scripts.push(script);
          if (script.includes("__chromaAe.listAnimatedProperties(")) {
            return {
              ok: true,
              durationMs: 1,
              result: {
                comp: { id: 7, name: "Shot", fps: 25, width: 1920, height: 1080, workAreaStart: 0, workAreaDuration: 2 },
                project_path: "C:/jobs/Shot.aep",
                layers_scanned: 2,
                truncated: false,
                properties: [
                  { layer: linear.layer, path: ["ADBE Transform Group", "ADBE Position"], name: "Position", matchName: "ADBE Position", num_keys: 2, first_key_time: 0, last_key_time: 1, expression: false },
                  { layer: eased.layer, path: ["ADBE Transform Group", "ADBE Scale"], name: "Scale", matchName: "ADBE Scale", num_keys: 2, first_key_time: 0, last_key_time: 1, expression: true },
                ],
              },
            };
          }
          return { ok: true, durationMs: 1, result: script.includes('"id":22') ? eased : linear };
        },
        queue,
        quarantine,
      });
      const tool = motionTools.find((t) => t.name === "ae_motion_review")!;
      const res = (await tool.handler(AeMotionReviewSchema.parse({ comp_id: 7 }), { bridge: host, queue, quarantine })) as Record<string, any>;

      expect(scripts).toHaveLength(3);
      const sampleCalls = scripts.filter((s) => s.includes("__chromaAe.sampleProperty("));
      expect(sampleCalls).toHaveLength(2);
      // Keys only: sampled between the keys. Expression: on to the work area end.
      expect(sampleCalls.find((s) => s.includes('"id":11'))).not.toContain('"end"');
      expect(sampleCalls.find((s) => s.includes('"id":22'))).toContain('"end":2');
      expect(res).toMatchObject({ ok: true, properties_scanned: 2, clean: false, counts: { medium: 1, low: 0, info: 0 }, by_kind: { linear: 1 } });
      expect(res.findings[0].layer.name).toBe("Ball");
      expect(res.findings[0].fix.args).toMatchObject({ layer: { id: 11 }, keys: [1, 2], ease: "easy_ease", expect: { project_path: "C:/jobs/Shot.aep" } });
      expect(AeMotionReviewSchema.safeParse({ comp_id: 7, max_findings: 0 }).success).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("panel/host/ext/motion.jsx listAnimatedProperties in a simulated AE DOM", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../panel/host/ext/motion.jsx"), "utf8");
  const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };
  const PropertyValueType = { OneD: 1, TwoD: 2, TwoD_SPATIAL: 3, ThreeD: 4, ThreeD_SPATIAL: 5, COLOR: 6, NO_VALUE: 7, TEXT_DOCUMENT: 8 };

  const prop = (name: string, matchName: string, numKeys: number, valueType = PropertyValueType.OneD, expression = "") => ({
    name,
    matchName,
    numKeys,
    propertyType: PropertyType.PROPERTY,
    propertyValueType: valueType,
    keyTime: (k: number) => k * 0.5,
    canSetExpression: true,
    expressionEnabled: expression !== "",
    expression,
  });
  const group = (name: string, matchName: string, type: number, children: any[]) => ({
    name,
    matchName,
    propertyType: type,
    numProperties: children.length,
    property: (k: number) => children[k - 1],
  });

  function simulatedComp() {
    class CompItem {}
    const blur = group("Blur 2", "ADBE Gaussian Blur 2", PropertyType.NAMED_GROUP, [
      prop("Blurriness", "ADBE Gaussian Blur 2-0001", 3, PropertyValueType.OneD, "value + wiggle(2, 5)"),
    ]);
    const layer = {
      ...group("Ball", "ADBE Vector Layer", PropertyType.NAMED_GROUP, [
        prop("Marker", "ADBE Marker", 4, PropertyValueType.NO_VALUE),
        group("Transform", "ADBE Transform Group", PropertyType.NAMED_GROUP, [
          prop("Position", "ADBE Position", 3, PropertyValueType.ThreeD_SPATIAL),
          prop("Opacity", "ADBE Opacity", 1),
          prop("Rotation", "ADBE Rotate Z", 0),
        ]),
        group("Effects", "ADBE Effect Parade", PropertyType.INDEXED_GROUP, [blur]),
      ]),
      index: 1,
      id: 11,
    };
    const comp = Object.assign(new CompItem(), {
      id: 5,
      name: "Shot",
      frameRate: 25,
      width: 640,
      height: 360,
      workAreaStart: 0,
      workAreaDuration: 2,
      numLayers: 1,
      layer: (sel: number | string) => (sel === 1 || sel === "Ball" ? layer : null),
    });
    const G: Record<string, any> = {
      __chromaAe: {},
      Array,
      CompItem,
      PropertyType,
      PropertyValueType,
      KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
      app: { project: { file: { fsName: "C:\\jobs\\Shot.aep" }, itemByID: (id: number) => (id === 5 ? comp : null) } },
    };
    G.$ = { global: G };
    vm.runInNewContext(source, G);
    return G.__chromaAe;
  }

  it("finds keyframed numeric properties, naming effects by display name, and skips markers and single keys", () => {
    const res = simulatedComp().listAnimatedProperties({ comp_id: 5 });
    expect(res.project_path).toBe("C:\\jobs\\Shot.aep");
    expect(res.comp).toMatchObject({ id: 5, fps: 25, width: 640 });
    expect(res.truncated).toBe(false);
    expect(res.properties.map((p: any) => p.path)).toEqual([
      ["ADBE Transform Group", "ADBE Position"],
      ["ADBE Effect Parade", "Blur 2", "ADBE Gaussian Blur 2-0001"],
    ]);
    expect(res.properties[0]).toMatchObject({
      layer: { id: 11, name: "Ball" },
      name: "Position",
      num_keys: 3,
      first_key_time: 0.5,
      last_key_time: 1.5,
      expression: false,
    });
    expect(res.properties[1].expression).toBe(true);
  });

  it("limits the scan to the given layers", () => {
    const A = simulatedComp();
    expect(A.listAnimatedProperties({ comp_id: 5, layers: [{ name: "Ball" }] }).layers_scanned).toBe(1);
    expect(() => A.listAnimatedProperties({ comp_id: 5, layers: [{ name: "Ghost" }] })).toThrow(/No layer named/);
  });
});
