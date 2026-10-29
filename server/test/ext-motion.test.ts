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
  analyzeMotion,
  buildContactSheet,
  chooseColumns,
  contactSheetTimes,
  formatNumber,
  frameLabel,
  MAX_SHEET_EDGE,
  motionTools,
  type PropertyKey,
  type PropertySamples,
  renderMotionGraph,
  sampleSpeeds,
  segmentProfile,
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
