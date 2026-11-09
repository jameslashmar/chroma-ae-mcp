import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeScrubCheckSchema,
  analyzePairs,
  buildSuspectSheet,
  DEFAULT_THRESHOLDS,
  describeRanges,
  drawScrubChart,
  framesInRange,
  intendedCuts,
  measureFrame,
  measurePairs,
  nearCut,
  planSamples,
  scrubTools,
  sequenceGaps,
  sizeFindings,
  verdictOf,
  type AnalysisContext,
  type Captured,
  type FrameMeasure,
  type PairMeasure,
  type ScrubFinding,
} from "../src/tools/ext/scrub.js";
import { FakeProject, GUARD, loadHost, MarkerValue } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
const origLocalAppData = process.env.LOCALAPPDATA;

const origHome = process.env.HOME;
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Frames, the chart and the sheet are written under the data dir.
  process.env.LOCALAPPDATA = process.env.HOME = tempDir("chroma-scrub-data-");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocalAppData;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = scrubTools.find((t) => t.name === "ae_scrub_check")!;

// ---------- synthetic frames ----------

const W = 32;
const H = 18;

/** A frame that is never flat or black: a gradient that slides a little each frame, optionally inverted or black. */
function frameData(k: number, opts: { invert?: boolean; black?: boolean; hold?: number } = {}): PNG {
  const png = new PNG({ width: W, height: H });
  const shown = opts.hold !== undefined ? Math.min(k, opts.hold) : k;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r = (x * 6 + shown * 2) % 200;
      let g = 40 + y * 8;
      let b = 90;
      if (opts.invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      if (opts.black) {
        r = 0;
        g = 0;
        b = 0;
      }
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

function writeFrame(file: string, png: PNG): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

// ---------- fake panel ----------

interface Scene {
  (k: number): PNG;
}

/** A PanelHost whose AE answers from a function, writing a PNG for every snapshotFrame. */
function fakeAe(answer: (fn: string, args: any) => unknown, scene: Scene, fd = 0.1) {
  const calls: string[] = [];
  const dir = tempDir("chroma-scrub-q-");
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const open = script.indexOf("(");
      const fn = script.slice("__chromaAe.".length, open);
      const args = JSON.parse(script.slice(open + 1, script.lastIndexOf(")")));
      calls.push(fn);
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true }, durationMs: 1 };
      if (fn === "snapshotFrame") {
        const k = Math.floor(args.time / fd + 1e-6);
        writeFrame(args.output_path, scene(k));
        return { ok: true, result: { path: args.output_path, time: args.time, width: W, height: H }, durationMs: 1 };
      }
      const r = answer(fn, args);
      if (r instanceof Error) return { ok: false, error: { kind: "host_error", message: r.message }, durationMs: 1 } as any;
      return { ok: true, result: r, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const compInfo = (extra: object = {}) => ({
  comp_id: 1,
  name: "Main",
  width: W,
  height: H,
  pixelAspect: 1,
  frameRate: 10,
  frameDuration: 0.1,
  duration: 1,
  workAreaStart: 0,
  workAreaDuration: 1,
  numLayers: 2,
  markers: [],
  markers_truncated: false,
  layer_edges: [],
  layer_edges_truncated: false,
  ...extra,
});

const kindsOf = (res: any) => (res.findings as ScrubFinding[]).map((f) => f.kind);

// ---------- pure logic ----------

describe("ae_scrub_check schema", () => {
  const expectArg = { project_path: "<unsaved>" };

  it("takes a comp or a render file, never both, and a file needs expect", () => {
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(AeScrubCheckSchema.safeParse({}).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, path: "C:/r.mov", expect: expectArg }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ path: "C:/r.mov" }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ path: "C:/r.mov", expect: expectArg }).success).toBe(true);
  });

  it("bounds the sample count, the range and the suspects", () => {
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, samples: 1 }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, samples: 61 }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, samples: 60 }).success).toBe(true);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, start: 2, end: 1 }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, max_suspects: 9 }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, expected_size: [1920] }).success).toBe(false);
    expect(AeScrubCheckSchema.safeParse({ comp_id: 1, thresholds: { pop_factor: 0.5 } }).success).toBe(false);
  });

  it("ends its description with the safety guidance and says what is not included", () => {
    expect(tool.description).toMatch(/IMPORTANT: \(1\) Always re-read/);
    expect(tool.description).toMatch(/silent-audio-tail/);
  });
});

describe("planSamples", () => {
  it("checks every frame of a short range, each frame once", () => {
    const plan = planSamples(10, 24);
    expect(plan.dense).toBe(true);
    expect(plan.indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(plan.pairs).toHaveLength(9);
    expect(plan.pairs[8]).toEqual([8, 9]);
  });

  it("spreads pairs of neighbouring frames and always takes the first and the last", () => {
    const plan = planSamples(100, 5);
    expect(plan.dense).toBe(false);
    expect(plan.pairs).toHaveLength(5);
    expect(plan.indexes[plan.pairs[0][0]]).toBe(0);
    expect(plan.indexes[plan.pairs[4][1]]).toBe(99);
    for (const [a, b] of plan.pairs) expect(plan.indexes[b] - plan.indexes[a]).toBe(1);
    expect(plan.indexes).toHaveLength(10);
  });

  it("renders a frame shared by two pairs once", () => {
    const plan = planSamples(12, 10);
    expect(new Set(plan.indexes).size).toBe(plan.indexes.length);
    for (const [a, b] of plan.pairs) expect(plan.indexes[b] - plan.indexes[a]).toBe(1);
    expect(plan.indexes.length).toBeLessThan(plan.pairs.length * 2);
  });

  it("has nothing to sample under two frames", () => {
    expect(planSamples(1, 10).pairs).toEqual([]);
    expect(framesInRange(0, 0.05, 0.1)).toBe(0);
    expect(framesInRange(1, 3, 0.5)).toBe(4);
    expect(framesInRange(0, 1, 1001 / 30000)).toBe(29);
  });
});

describe("image sequence gaps", () => {
  it("lists the numbers missing between the first and the last frame", () => {
    const names = ["a_0001.png", "a_0002.png", "a_0005.png", "a_0006.png", "a_0009.png", "b_0003.png", "a_12.png", "notes.txt"];
    const g = sequenceGaps(names, "a_0001.png")!;
    expect(g).toMatchObject({ pattern: "a_####.png", first: 1, last: 9, present: 5 });
    expect(g.missing).toEqual([3, 4, 7, 8]);
    expect(describeRanges(g.missing)).toBe("3-4, 7-8");
  });

  it("finds nothing missing in a whole sequence, and caps a long list", () => {
    expect(sequenceGaps(["x.001.png", "x.002.png", "x.003.png"], "x.002.png")!.missing).toEqual([]);
    const sparse = ["f_000001.exr", "f_001500.exr"];
    const g = sequenceGaps(sparse, "f_000001.exr")!;
    expect(g.missing).toHaveLength(500);
    expect(g.truncated).toBe(true);
    expect(sequenceGaps(["other.png"], "a_0001.png")).toBeNull();
  });
});

describe("cuts, sizes and verdicts", () => {
  it("collects markers, layer edges and given times inside the range only", () => {
    const info = { markers: [{ time: 0.5 }, { time: 9 }], layer_edges: [{ time: 0 }, { time: 0.5 }, { time: 0.75 }] };
    expect(intendedCuts(info, [0.25, 0.25], true, { start: 0, end: 1 })).toEqual([0.25, 0.5, 0.75]);
    expect(intendedCuts(info, [0.25], false, { start: 0, end: 1 })).toEqual([0.25]);
    expect(intendedCuts(null, undefined, true, { start: 0, end: 1 })).toEqual([]);
  });

  it("sees a cut between the pair's frames, give or take a frame", () => {
    const p = { a_time: 0.4, b_time: 0.5 };
    expect(nearCut(p, [0.5], 0.1)).toBe(true);
    expect(nearCut(p, [0.3], 0.1)).toBe(true);
    expect(nearCut(p, [0.7], 0.1)).toBe(false);
  });

  it("fails a wrong size or aspect and flags non-square pixels", () => {
    expect(sizeFindings({ width: 1920, height: 1080, pixelAspect: 1 }, [1920, 1080], true)).toEqual([]);
    const scaled = sizeFindings({ width: 960, height: 540, pixelAspect: 1 }, [1920, 1080], true);
    expect(scaled).toMatchObject([{ kind: "size", severity: "fail" }]);
    const aspect = sizeFindings({ width: 1080, height: 1080, pixelAspect: 1 }, [1920, 1080], true);
    expect(aspect).toMatchObject([{ kind: "aspect", severity: "fail" }]);
    expect(sizeFindings({ width: 720, height: 480, pixelAspect: 0.9 }, undefined, true)[0]).toMatchObject({ kind: "aspect", severity: "warn" });
    expect(sizeFindings({ width: 720, height: 480, pixelAspect: 0.9 }, undefined, false)[0].severity).toBe("info");
  });

  it("is fail over warn over pass", () => {
    const f = (severity: ScrubFinding["severity"]): ScrubFinding => ({ kind: "pop", severity, message: "" });
    expect(verdictOf([])).toBe("pass");
    expect(verdictOf([f("info")])).toBe("pass");
    expect(verdictOf([f("info"), f("warn")])).toBe("warn");
    expect(verdictOf([f("warn"), f("fail")])).toBe("fail");
  });
});

let hashCounter = 0;
const fm = (o: Partial<FrameMeasure> = {}): FrameMeasure => ({
  hash: `h${hashCounter++}`,
  kind: null,
  flags: [],
  mean_luma: 0.5,
  clip_frac: 0,
  edges: { top: 1, bottom: 1, left: 1, right: 1 },
  width: W,
  height: H,
  ...o,
});

/** Pair i covers frames i*2 and i*2+1 of a 10 fps shot, 0.2 s apart. */
function pair(i: number, o: Partial<PairMeasure> & { a?: Partial<FrameMeasure>; b?: Partial<FrameMeasure> } = {}): PairMeasure {
  const { a, b, ...rest } = o;
  return {
    index: i,
    a_pos: i * 2,
    b_pos: i * 2 + 1,
    a_time: Math.round(i * 2) / 10,
    b_time: Math.round(i * 2 + 1) / 10,
    a: fm(a),
    b: fm(b),
    mean_abs_diff: 0.004,
    pct_changed: 5,
    luma_delta: 0,
    ...rest,
  };
}

const ctxOf = (n: number, extra: Partial<AnalysisContext> = {}): AnalysisContext => ({
  frameDuration: 0.1,
  rangeStart: 0,
  rangeEnd: n * 0.2,
  cuts: [],
  thresholds: DEFAULT_THRESHOLDS,
  ...extra,
});

const six = (f: (i: number) => PairMeasure) => Array.from({ length: 6 }, (_, i) => f(i));

describe("analyzePairs", () => {
  it("passes steady motion", () => {
    expect(analyzePairs(six((i) => pair(i)), ctxOf(6))).toEqual([]);
  });

  it("fails black frames at the end of the range and warns for them in the middle", () => {
    const tail = analyzePairs(six((i) => (i >= 3 ? pair(i, { a: { kind: "black" }, b: { kind: "black" } }) : pair(i))), ctxOf(6));
    expect(tail).toMatchObject([{ kind: "black", severity: "fail", time: 0.6 }]);
    expect(tail[0].message).toMatch(/to the end of the range/);
    // a fade to black or from black (one short stretch at an end) is only a warning
    const fadeOut = analyzePairs(six((i) => (i === 5 ? pair(i, { b: { kind: "black" } }) : pair(i))), ctxOf(6));
    expect(fadeOut).toMatchObject([{ kind: "black", severity: "warn", time: 1 }]);
    const fadeIn = analyzePairs(six((i) => (i === 0 ? pair(i, { a: { kind: "black" } }) : pair(i))), ctxOf(6));
    expect(fadeIn).toMatchObject([{ kind: "black", severity: "warn" }]);
    // ...until it is longer than black_min_seconds, which the caller can change
    const strict = analyzePairs(six((i) => (i === 5 ? pair(i, { b: { kind: "black" } }) : pair(i))), ctxOf(6, { thresholds: { ...DEFAULT_THRESHOLDS, black_min_seconds: 0.1 } }));
    expect(strict).toMatchObject([{ kind: "black", severity: "fail" }]);
    // a transparent opening (elements animating in) is at most a warning; a long transparent tail fails
    const open = analyzePairs(six((i) => (i <= 2 ? pair(i, { a: { kind: "transparent" }, b: { kind: "transparent" } }) : pair(i))), ctxOf(6));
    expect(open).toMatchObject([{ kind: "transparent", severity: "warn" }]);
    const tailClear = analyzePairs(six((i) => (i >= 3 ? pair(i, { a: { kind: "transparent" }, b: { kind: "transparent" } }) : pair(i))), ctxOf(6));
    expect(tailClear).toMatchObject([{ kind: "transparent", severity: "fail" }]);
    const mid = analyzePairs(six((i) => (i === 2 ? pair(i, { a: { kind: "black" }, b: { kind: "black" } }) : pair(i))), ctxOf(6));
    expect(mid).toMatchObject([{ kind: "black", severity: "warn" }]);
    const clear = analyzePairs(six((i) => pair(i, { a: { kind: "transparent" }, b: { kind: "transparent" } })), ctxOf(6));
    expect(clear).toMatchObject([{ kind: "transparent", severity: "fail" }]);
    expect(clear[0].message).toMatch(/whole checked range/);
  });

  it("reports a flat colour mid-shot as a note only", () => {
    const f = analyzePairs(six((i) => (i === 3 ? pair(i, { a: { kind: "blank" }, b: { kind: "blank" } }) : pair(i))), ctxOf(6));
    expect(f).toMatchObject([{ kind: "blank", severity: "info" }]);
  });

  it("finds a frozen run when every sample point shows the same frame, and warns when it reaches the end", () => {
    const frozen = analyzePairs(
      six((i) => (i >= 3 ? pair(i, { a: { hash: "same" }, b: { hash: "same" }, mean_abs_diff: 0 }) : pair(i))),
      ctxOf(6)
    );
    expect(frozen).toMatchObject([{ kind: "frozen", severity: "warn", time: 0.6 }]);
    expect(frozen[0].value).toBeCloseTo(0.6, 5);
    // the same hold in the middle is only a note
    const hold = analyzePairs(
      six((i) => (i >= 1 && i <= 3 ? pair(i, { a: { hash: "same" }, b: { hash: "same" }, mean_abs_diff: 0 }) : pair(i))),
      ctxOf(6, { rangeEnd: 5 })
    );
    expect(hold).toMatchObject([{ kind: "frozen", severity: "info" }]);
  });

  it("ignores a hold shorter than the minimum and a single identical pair", () => {
    const one = analyzePairs(six((i) => (i === 2 ? pair(i, { a: { hash: "s" }, b: { hash: "s" }, mean_abs_diff: 0 }) : pair(i))), ctxOf(6));
    expect(one).toEqual([]);
    const short = analyzePairs(
      six((i) => (i >= 4 ? pair(i, { a: { hash: "s" }, b: { hash: "s" }, mean_abs_diff: 0 }) : pair(i))),
      ctxOf(6, { thresholds: { ...DEFAULT_THRESHOLDS, frozen_min_seconds: 5 } })
    );
    expect(short.filter((f) => f.kind === "frozen")).toEqual([]);
  });

  it("flags a pop far above the usual change, but not at a marker or when the whole shot is busy", () => {
    const poppy = six((i) => pair(i, { mean_abs_diff: i === 3 ? 0.4 : 0.004 }));
    const found = analyzePairs(poppy, ctxOf(6));
    expect(found).toMatchObject([{ kind: "pop", severity: "warn", time: 0.6, end_time: 0.7 }]);
    expect(found[0].tiles).toEqual([6, 7]);
    // a cut at 0.7 s explains it
    expect(analyzePairs(poppy, ctxOf(6, { cuts: [0.7] }))).toEqual([]);
    // fast motion all through: nothing stands out
    const busy = six((i) => pair(i, { mean_abs_diff: i === 3 ? 0.4 : 0.2 }));
    expect(analyzePairs(busy, ctxOf(6))).toEqual([]);
    // below the absolute minimum, however large the ratio
    const small = six((i) => pair(i, { mean_abs_diff: i === 3 ? 0.02 : 0.0005 }));
    expect(analyzePairs(small, ctxOf(6))).toEqual([]);
  });

  it("flags flicker when brightness keeps swinging both ways, not a fade", () => {
    const flicker = analyzePairs(six((i) => pair(i, { luma_delta: i % 2 === 0 ? 0.1 : -0.1 })), ctxOf(6));
    expect(flicker).toMatchObject([{ kind: "flicker", severity: "warn", value: 6 }]);
    const fade = analyzePairs(six((i) => pair(i, { luma_delta: i < 3 ? 0.1 : -0.1 })), ctxOf(6));
    expect(fade.filter((f) => f.kind === "flicker")).toEqual([]);
    const up = analyzePairs(six((i) => pair(i, { luma_delta: 0.1 })), ctxOf(6));
    expect(up.filter((f) => f.kind === "flicker")).toEqual([]);
  });

  it("notes content that reaches an edge in some frames only, never a full-bleed picture", () => {
    const edge = analyzePairs(
      six((i) => pair(i, { a: { edges: { top: 0, bottom: 0, left: i < 2 ? 0.6 : 0, right: 0 } }, b: { edges: { top: 0, bottom: 0, left: 0, right: 0 } } })),
      ctxOf(6)
    );
    expect(edge).toMatchObject([{ kind: "edge_clip", severity: "info", value: 2 }]);
    expect(edge[0].message).toMatch(/left edge in 2 of 7/);
    expect(analyzePairs(six((i) => pair(i)), ctxOf(6)).filter((f) => f.kind === "edge_clip")).toEqual([]);
  });

  it("notes clipped highlights as an RGB heuristic", () => {
    const f = analyzePairs(six((i) => pair(i, { a: { clip_frac: i === 4 ? 0.2 : 0 } })), ctxOf(6));
    expect(f).toMatchObject([{ kind: "rgb_extremes", severity: "info", time: 0.8 }]);
    expect(f[0].message).toMatch(/full-range RGB/);
  });

  it("sorts failures before warnings before notes", () => {
    const f = analyzePairs(
      six((i) => pair(i, { mean_abs_diff: i === 1 ? 0.4 : 0.004, a: i >= 3 ? { kind: "black", clip_frac: 0.5 } : { clip_frac: 0.5 }, b: i >= 3 ? { kind: "black" } : {} })),
      ctxOf(6)
    );
    expect(f.map((x) => x.severity)).toEqual(["fail", "warn", "info"]);
  });
});

describe("frame measurement", () => {
  it("measures kind, brightness, clipping and edge content in one pass", () => {
    const m = measureFrame(frameData(0));
    expect(m.kind).toBeNull();
    expect(m.mean_luma).toBeGreaterThan(0.1);
    expect(m.mean_luma).toBeLessThan(0.9);
    expect(m.edges).toEqual({ top: 1, bottom: 1, left: 1, right: 1 });
    expect(m.hash).toHaveLength(32);
    expect(measureFrame(frameData(0)).hash).toBe(m.hash);
    expect(measureFrame(frameData(1)).hash).not.toBe(m.hash);
    expect(measureFrame(frameData(0, { black: true })).kind).toBe("black");
    const clear = new PNG({ width: 8, height: 8 });
    expect(measureFrame(clear).kind).toBe("transparent");
    const white = new PNG({ width: 8, height: 8 });
    white.data.fill(255);
    const w = measureFrame(white);
    expect(w).toMatchObject({ kind: "blank", clip_frac: 1 });
  });

  it("sees content on one edge only", () => {
    const png = new PNG({ width: 40, height: 40 });
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const i = (y * 40 + x) * 4;
        png.data[i + 3] = 255;
        if (x < 10) png.data[i] = 200;
      }
    }
    const m = measureFrame(png);
    expect(m.edges.left).toBe(1);
    expect(m.edges.right).toBe(0);
    expect(m.edges.top).toBeGreaterThan(0);
    expect(m.edges.top).toBeLessThan(0.5);
  });

  it("decodes frames pair by pair and reports a pair it can't compare", () => {
    const dir = tempDir("chroma-scrub-pairs-");
    const cap: Array<Captured | null> = [0, 1, 2, 3].map((k) => {
      const p = path.join(dir, `f${k}.png`);
      writeFrame(p, k === 3 ? frameData(k, { invert: true }) : frameData(k));
      return { pos: k, k, frame_time: k * 0.1, path: p };
    });
    cap[2] = null;
    const out = measurePairs(cap, [[0, 1], [2, 3]]);
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]).toMatchObject({ a_pos: 0, b_pos: 1, a_time: 0, b_time: 0.1 });
    expect(out.pairs[0].mean_abs_diff).toBeGreaterThan(0);
    // a dense chain shares frame 1 between two pairs
    const dense = measurePairs(
      [0, 1, 2].map((k) => ({ pos: k, k, frame_time: k * 0.1, path: path.join(dir, `f${k}.png`) })),
      [[0, 1], [1, 2]]
    );
    expect(dense.pairs).toHaveLength(2);
    expect(dense.pairs[0].b.hash).toBe(dense.pairs[1].a.hash);
    // a file that is not a PNG
    fs.writeFileSync(path.join(dir, "bad.png"), "nope");
    const bad = measurePairs([{ pos: 0, k: 0, frame_time: 0, path: path.join(dir, "bad.png") }, cap[1]], [[0, 1]]);
    expect(bad.pairs).toEqual([]);
    expect(bad.errors).toHaveLength(1);
  });
});

describe("drawing", () => {
  it("draws the difference curve with cuts and findings", () => {
    const png = drawScrubChart(
      [0, 1, 2, 3].map((i) => ({ time: i * 0.2, diff: i === 2 ? 0.3 : 0.01, luma: 0.5 })),
      { start: 0, end: 1 },
      [0.5],
      [0.4]
    );
    expect(png.width).toBe(960);
    // somewhere a finding tick is red-ish and a cut tick yellow
    const px = (x: number, y: number) => [...png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
    expect(px(Math.round(8 + 0.5 * (960 - 16)), 100)).toEqual([230, 190, 40]);
  });

  it("puts each suspect frame beside its neighbour on a labelled sheet", () => {
    const dir = tempDir("chroma-scrub-sheet-");
    const cap: Array<Captured | null> = [0, 1, 2, 3].map((k) => {
      const p = path.join(dir, `f${k}.png`);
      writeFrame(p, frameData(k));
      return { pos: k, k, frame_time: k * 0.1, path: p };
    });
    const findings: ScrubFinding[] = [
      { kind: "pop", severity: "warn", message: "", time: 0, tiles: [0, 1] },
      { kind: "black", severity: "fail", message: "", time: 0.2, tiles: [2, 3] },
      { kind: "edge_clip", severity: "info", message: "", time: 0.3 },
    ];
    const built = buildSuspectSheet(cap, findings, 6, { width: W, height: H })!;
    expect(built.shown).toHaveLength(2);
    expect(built.shown[1].paths).toEqual([cap[2]!.path, cap[3]!.path]);
    expect(built.png.width).toBeGreaterThan(W * 2);
    expect(buildSuspectSheet(cap, [findings[2]], 6, { width: W, height: H })).toBeNull();
    expect(buildSuspectSheet(cap, findings, 1, { width: W, height: H })!.shown).toHaveLength(1);
  });
});

// ---------- the tool, with a fake bridge ----------

describe("ae_scrub_check on a comp", () => {
  const answers = (info = compInfo()) => (fn: string) => {
    if (fn === "scrubInfo") return info;
    return new Error(`Unexpected host call ${fn}`);
  };

  it("reads the comp, renders pairs and finds a pop and black last frames, without guard, checkpoint or any write", async () => {
    // frames 5.. are inverted; frames 6.. are black
    const scene: Scene = (k) => (k >= 6 ? frameData(k, { black: true }) : frameData(k, { invert: k >= 5 }));
    const { ctx, calls } = fakeAe(answers(), scene);
    const args = AeScrubCheckSchema.parse({ comp_id: 1, samples: 5, thresholds: { black_min_seconds: 0.3 } });
    const res: any = await tool.handler(args, ctx);
    expect(calls[0]).toBe("scrubInfo");
    expect(calls.filter((c) => c === "snapshotFrame")).toHaveLength(10);
    expect(calls).not.toContain("checkGuard");
    expect(calls).not.toContain("scrubImport");
    expect(res).toMatchObject({ ok: true, mode: "comp", verdict: "fail" });
    expect(res.range).toMatchObject({ start: 0, end: 1, frames: 10, frame_duration: 0.1 });
    expect(res.coverage).toMatchObject({ sample_points: 5, frames_rendered: 10, dense: false });
    const kinds = kindsOf(res);
    expect(kinds).toContain("pop");
    expect(kinds).toContain("black");
    const pop = res.findings.find((f: ScrubFinding) => f.kind === "pop" && f.time! < 0.5);
    expect(pop.time).toBeCloseTo(0.4, 6);
    expect(res.findings.find((f: ScrubFinding) => f.kind === "black")).toMatchObject({ severity: "fail" });
    expect(res.findings[0].severity).toBe("fail");
    expect(res.findings[0].tiles).toBeUndefined();
    // the chart and the sheet are PNGs on disk, and only suspect frames are left
    expect(PNG.sync.read(fs.readFileSync(res.chart.path)).width).toBe(960);
    expect(PNG.sync.read(fs.readFileSync(res.contact_sheet.path)).width).toBeGreaterThan(W);
    expect(res.curve).toHaveLength(5);
    const kept = fs.readdirSync(path.dirname(res.chart.path)).filter((n) => n.startsWith("frame_c"));
    const suspects = new Set(res.suspect_frames.flatMap((s: { frame: string; next: string }) => [s.frame, s.next]));
    expect(kept.length).toBe(suspects.size);
    expect(kept.length).toBeLessThan(10);
  }, 30_000);

  it("leaves a pop alone when a marker or layer edge explains it, and keeps every frame on request", async () => {
    const scene: Scene = (k) => frameData(k, { invert: k >= 5 });
    const info = compInfo({ markers: [{ time: 0.5, comment: "cut" }], layer_edges: [{ time: 0.5, edge: "in", layer: "B" }] });
    const { ctx } = fakeAe(answers(info), scene);
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 5, keep_frames: true }), ctx);
    expect(res.verdict).toBe("pass");
    expect(res.cuts).toMatchObject({ count: 1, markers: 1, layer_edges: 1, given: 0 });
    expect(fs.readdirSync(path.dirname(res.chart.path)).filter((n) => n.startsWith("frame_c"))).toHaveLength(10);
    // without them the same shot pops
    const again = fakeAe(answers(info), scene);
    const loud: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 5, use_markers_as_cuts: false }), again.ctx);
    expect(kindsOf(loud)).toContain("pop");
    // or the caller's own cut list
    const given = fakeAe(answers(info), scene);
    const quiet: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 5, use_markers_as_cuts: false, cut_times: [0.5] }), given.ctx);
    expect(quiet.verdict).toBe("pass");
  }, 30_000);

  it("finds a hold that runs to the end, and keeps to a narrowed range", async () => {
    const scene: Scene = (k) => frameData(k, { hold: 3 });
    const { ctx, calls } = fakeAe(answers(), scene);
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 3 }), ctx);
    expect(res.findings.find((f: ScrubFinding) => f.kind === "frozen")).toMatchObject({ severity: "warn" });
    expect(res.verdict).toBe("warn");
    const narrow = fakeAe(answers(), scene);
    const part: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, start: 0.2, end: 0.6, samples: 10 }), narrow.ctx);
    expect(part.range).toMatchObject({ start: 0.2, end: 0.6, frames: 4 });
    expect(part.coverage.dense).toBe(true);
    expect(narrow.calls.filter((c) => c === "snapshotFrame")).toHaveLength(4);
    expect(calls.filter((c) => c === "snapshotFrame")).toHaveLength(6);
  }, 30_000);

  it("reports a frame that can't be rendered and still judges the rest", async () => {
    // the pair at frames 2 and 3 fails to write: the bridge answers with an error for that time
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-scrub-q2-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const open = script.indexOf("(");
        const fn = script.slice("__chromaAe.".length, open);
        const args = JSON.parse(script.slice(open + 1, script.lastIndexOf(")")));
        calls.push(fn);
        if (fn === "scrubInfo") return { ok: true, result: compInfo(), durationMs: 1 };
        const k = Math.floor(args.time / 0.1 + 1e-6);
        if (k === 2 || k === 3) return { ok: false, error: { kind: "host_error", message: "render failed" }, durationMs: 1 } as any;
        writeFrame(args.output_path, frameData(k));
        return { ok: true, result: {}, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 5 }), { bridge: host, queue, quarantine });
    expect(res.ok).toBe(true);
    expect(res.findings.filter((f: ScrubFinding) => f.kind === "capture_failed").length).toBeGreaterThan(0);
    expect(res.coverage.sample_points).toBe(4);
    expect(res.verdict).toBe("warn");
  }, 30_000);

  it("refuses a range under two frames without rendering", async () => {
    const { ctx, calls } = fakeAe(answers(), (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, start: 0.3, end: 0.35 }), ctx);
    expect(res).toMatchObject({ ok: false, error: "range_too_short" });
    expect(calls).toEqual(["scrubInfo"]);
  });

  it("notes a wrong size", async () => {
    const { ctx } = fakeAe(answers(), (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 2, expected_size: [1920, 1080] }), ctx);
    expect(res.verdict).toBe("fail");
    expect(kindsOf(res)).toContain("size");
    const square = fakeAe(answers(), (k) => frameData(k));
    const wrong: any = await tool.handler(AeScrubCheckSchema.parse({ comp_id: 1, samples: 2, expected_size: [100, 100] }), square.ctx);
    expect(kindsOf(wrong)).toContain("aspect");
  }, 30_000);
});

describe("ae_scrub_check on a render file", () => {
  const imported = {
    item_id: 7,
    comp_id: 8,
    name: "render.mov",
    width: W,
    height: H,
    pixelAspect: 1,
    frameRate: 10,
    frameDuration: 0.1,
    duration: 1,
    sequence: false,
  };

  function movie(): string {
    const file = path.join(tempDir("chroma-scrub-file-"), "render.mov");
    fs.writeFileSync(file, "movie");
    return file;
  }

  const present = {
    item: { id: 7, name: "render.mov", frameRate: 10, duration: 1 },
    comp: { id: 8, name: "x", numLayers: 1, frameRate: 10, duration: 1 },
  };

  // Before the removal a separate read finds the item and the comp; after it, nothing (unless `state` says otherwise).
  function flow(state?: { item: unknown; comp: unknown }, remove: unknown = { removed_comp: 8, removed_item: 7, item_kept: false }) {
    let removed = false;
    return (fn: string) => {
      if (fn === "scrubImport") return imported;
      if (fn === "scrubRemove") {
        removed = true;
        return remove;
      }
      if (fn === "scrubState") {
        if (state) return state;
        return removed ? { item: null, comp: null } : present;
      }
      return new Error(`Unexpected ${fn}`);
    };
  }

  it("guards, checkpoints, imports, renders, removes, and reads back that both are gone", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe(flow(), (k) => (k >= 4 ? frameData(k, { black: true }) : frameData(k)));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 5, expect: GUARD }), ctx);
    expect(calls[0]).toBe("checkGuard");
    expect(calls[1]).toBe("scrubImport");
    // rate and length are read back in their own call before any frame is taken
    expect(calls[2]).toBe("scrubState");
    expect(calls.slice(3, 13).every((c) => c === "snapshotFrame")).toBe(true);
    expect(calls.slice(-2)).toEqual(["scrubRemove", "scrubState"]);
    expect(res).toMatchObject({ ok: true, mode: "file", verdict: "fail", project_changed: true, imported_state: "removed", left_in_project: null });
    expect(res.file).toMatchObject({ path: file, width: W, height: H, sequence: false });
    expect(res.checkpoint).toBeDefined();
    expect(res.findings.find((f: ScrubFinding) => f.kind === "black")).toMatchObject({ severity: "fail" });
    expect(res.problems).toBeUndefined();
  }, 30_000);

  it("takes the guard's refusal before importing anything", async () => {
    const file = movie();
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-scrub-q3-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        calls.push(script.slice("__chromaAe.".length, script.indexOf("(")));
        return { ok: true, result: { ok: true, project_path: "C:/other.aep", comp_id: null, comp_is_valid: true }, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    await expect(tool.handler(AeScrubCheckSchema.parse({ path: file, expect: GUARD }), { bridge: host, queue, quarantine })).rejects.toMatchObject({ kind: "guard" });
    expect(calls).toEqual(["checkGuard"]);
  });

  it("refuses a missing or empty file before touching AE", async () => {
    const { ctx, calls } = fakeAe(flow(), (k) => frameData(k));
    const missing = await tool.handler(AeScrubCheckSchema.parse({ path: path.join(os.tmpdir(), "chroma-scrub-nope.mov"), expect: GUARD }), ctx);
    expect(missing).toMatchObject({ ok: false, error: "bad_path" });
    const empty = path.join(tempDir("chroma-scrub-empty-"), "e.mov");
    fs.writeFileSync(empty, "");
    expect(await tool.handler(AeScrubCheckSchema.parse({ path: empty, expect: GUARD }), ctx)).toMatchObject({ ok: false, error: "empty" });
    expect(calls).toEqual([]);
  });

  it("reports what is left in the project when the removal can't be confirmed", async () => {
    const file = movie();
    let removed = false;
    const { ctx } = fakeAe((fn) => {
      if (fn === "scrubRemove") removed = true;
      if (fn === "scrubState" && removed) return { item: { id: 7, name: "render.mov" }, comp: null };
      return flow()(fn);
    }, (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect(res).toMatchObject({ ok: true, imported_state: "left", left_in_project: { item_id: 7, comp_id: 8 } });
    expect(res.problems[0].message).toMatch(/still in the project/);
  }, 30_000);

  it("after a capture timeout the removal of the imported render and comp is still sent, as a must-send cleanup", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe(flow(), (k) => frameData(k));
    const real = ctx.bridge.evalRaw.bind(ctx.bridge);
    const sent: Array<{ fn: string; mustSend: boolean | undefined }> = [];
    (ctx.bridge as any).evalRaw = async (params: any) => {
      const fn = String(params.script).slice("__chromaAe.".length, String(params.script).indexOf("("));
      sent.push({ fn, mustSend: params.mustSend });
      if (fn === "snapshotFrame") throw new BridgeError({ kind: "timeout", message: "timed out" });
      return real(params);
    };
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 3, expect: GUARD }), ctx);
    expect(calls).toContain("scrubRemove");
    expect(sent.find((x) => x.fn === "scrubRemove")).toMatchObject({ mustSend: true });
    expect(res.imported_state).toBe("removed");
  }, 30_000);

  it("a removal that times out is unknown (it is still queued and runs when AE answers), not left", async () => {
    const file = movie();
    const { ctx } = fakeAe(flow(), (k) => frameData(k));
    const real = ctx.bridge.evalRaw.bind(ctx.bridge);
    (ctx.bridge as any).evalRaw = async (params: any) => {
      if (String(params.script).startsWith("__chromaAe.scrubRemove(")) throw new BridgeError({ kind: "timeout", message: "timed out" });
      return real(params);
    };
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 3, expect: GUARD }), ctx);
    expect(res.imported_state).toBe("unknown");
    expect(res.left_in_project).toMatchObject({ item_id: 7, comp_id: 8 });
  }, 30_000);

  it("does not throw after the import when the removal fails: it reports the leftover items", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "scrubImport") return imported;
      if (fn === "scrubState") return present;
      if (fn === "scrubRemove") return new Error("AE refused");
      return new Error(`Unexpected ${fn}`);
    }, (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect(res).toMatchObject({ ok: true, imported_state: "left", left_in_project: { item_id: 7, comp_id: 8 } });
    expect(res.problems[0].message).toMatch(/Do not resend/);
    // only the timing read-back before sampling; no check for the removal
    expect(calls.filter((c) => c === "scrubState")).toHaveLength(1);
  }, 30_000);

  it("says the render was kept, not that the cleanup failed, when another comp uses it", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "scrubImport") return imported;
      if (fn === "scrubRemove") return { removed_comp: 8, removed_item: null, item_kept: true };
      if (fn === "scrubState") return calls.includes("scrubRemove") ? { item: { id: 7, name: "render.mov" }, comp: null } : present;
      return new Error("Unexpected " + fn);
    }, (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect(res).toMatchObject({ ok: true, imported_state: "kept_in_use", left_in_project: { item_id: 7 } });
    expect(res.left_in_project.comp_id).toBeUndefined();
    expect(res.problems).toBeUndefined();
    expect(res.notes.join(" ")).toMatch(/used by another comp/);
  }, 30_000);

  it("samples with the values from a separate read when the import call's were stale", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "scrubImport") return { ...imported, frameRate: 30, frameDuration: 1 / 30, duration: 1.6 };
      if (fn === "scrubState") {
        return calls.includes("scrubRemove")
          ? { item: null, comp: null }
          : { item: { id: 7, name: "render.mov", frameRate: 10, duration: 1 }, comp: { id: 8, name: "x", numLayers: 1, frameRate: 30, duration: 1.6 } };
      }
      if (fn === "scrubRemove") return { removed_comp: 8, removed_item: 7, item_kept: false };
      return new Error("Unexpected " + fn);
    }, (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect(res.range.end).toBe(1);
    expect(res.range.frame_duration).toBeCloseTo(0.1, 9);
    expect(res.notes.join(" ")).toMatch(/differs from a separate read/);
  }, 30_000);

  it("reports a problem and samples nothing when the separate read finds no item or comp, but still removes", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe(flow({ item: null, comp: null }), (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect(res).toMatchObject({ ok: false, error: "sampling_failed", applied: true });
    expect(res.problems.some((p: any) => p.path === "import")).toBe(true);
    expect(calls).not.toContain("snapshotFrame");
    expect(calls).toContain("scrubRemove");
  }, 30_000);

  it("flags a 29.97 import call against a 30 fps separate read", async () => {
    const file = movie();
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "scrubImport") return { ...imported, frameRate: 29.97, frameDuration: 1 / 29.97, duration: 1 };
      if (fn === "scrubState") {
        return calls.includes("scrubRemove")
          ? { item: null, comp: null }
          : { item: { id: 7, name: "render.mov", frameRate: 30, duration: 1 }, comp: { id: 8, name: "x", numLayers: 1, frameRate: 30, duration: 1 } };
      }
      if (fn === "scrubRemove") return { removed_comp: 8, removed_item: 7, item_kept: false };
      return new Error("Unexpected " + fn);
    }, (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect(res.range.frame_duration).toBeCloseTo(1 / 30, 9);
    expect(res.notes.join(" ")).toMatch(/differs from a separate read/);
  }, 30_000);

  it("does not flag NTSC float rates as a difference from the import call", async () => {
    const file = movie();
    const { ctx } = fakeAe((fn) => {
      if (fn === "scrubImport") return { ...imported, frameRate: 29.97, frameDuration: 1 / 29.97, duration: 1 };
      if (fn === "scrubState") return { item: { id: 7, name: "r", frameRate: 29.9700298, duration: 1 }, comp: { id: 8, name: "x", numLayers: 1, frameRate: 29.9700012, duration: 1 } };
      if (fn === "scrubRemove") return { removed_comp: 8, removed_item: 7, item_kept: false };
      return new Error("Unexpected " + fn);
    }, (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), ctx);
    expect((res.notes ?? []).join(" ")).not.toMatch(/differs from a separate read/);
  }, 30_000);

  it("bounds the path length", () => {
    expect(() => AeScrubCheckSchema.parse({ path: "C:/" + "a".repeat(20001) })).toThrow();
  });

  it("ignores sequence:true on a movie: no gap check, imported as a movie", async () => {
    const dir = tempDir("chroma-scrub-numbered-movie-");
    for (const n of ["render_001.mov", "render_004.mov"]) fs.writeFileSync(path.join(dir, n), "x");
    const { ctx, calls } = fakeAe(flow(), (k) => frameData(k));
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: path.join(dir, "render_001.mov"), sequence: true, samples: 2, expect: GUARD }), ctx);
    expect(calls).toContain("scrubImport");
    expect(res.file.sequence).toBe(false);
    expect(kindsOf(res)).not.toContain("sequence_gap");
  }, 30_000);

  it("removes the temporary items even when no frame could be rendered", async () => {
    const file = movie();
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-scrub-q4-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push(fn);
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true }, durationMs: 1 };
        if (fn === "scrubImport") return { ok: true, result: imported, durationMs: 1 };
        if (fn === "snapshotFrame") return { ok: false, error: { kind: "host_error", message: "no frame" }, durationMs: 1 } as any;
        if (fn === "scrubRemove") return { ok: true, result: {}, durationMs: 1 };
        return { ok: true, result: calls.includes("scrubRemove") ? { item: null, comp: null } : present, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const res: any = await tool.handler(AeScrubCheckSchema.parse({ path: file, samples: 2, expect: GUARD }), { bridge: host, queue, quarantine });
    expect(res.ok).toBe(true);
    expect(res.imported_state).toBe("removed");
    expect(res.verdict).toBe("warn");
    expect(kindsOf(res)).toContain("capture_failed");
    expect(calls.slice(-2)).toEqual(["scrubRemove", "scrubState"]);
  }, 30_000);

  it("fails missing numbers in an image sequence from the folder alone, and checks the expected size", async () => {
    const dir = tempDir("chroma-scrub-seq-");
    for (const n of ["shot_0001.png", "shot_0002.png", "shot_0005.png"]) fs.writeFileSync(path.join(dir, n), "x");
    const { ctx } = fakeAe(flow(), (k) => frameData(k));
    const res: any = await tool.handler(
      AeScrubCheckSchema.parse({ path: path.join(dir, "shot_0001.png"), samples: 2, expected_size: [64, 36], expect: GUARD }),
      ctx
    );
    expect(res.file.sequence).toBe(true);
    expect(res.sequence_check).toMatchObject({ pattern: "shot_####.png", first: 1, last: 5, missing: [3, 4] });
    const gap = res.findings.find((f: ScrubFinding) => f.kind === "sequence_gap");
    expect(gap).toMatchObject({ severity: "fail" });
    expect(gap.message).toMatch(/3-4/);
    expect(kindsOf(res)).toContain("size");
  }, 30_000);
});

// ---------- the host functions in the simulated AE ----------

function withItems(project: FakeProject) {
  (project as any).items = {
    addComp: (name: string, w: number, h: number, pa: number, dur: number, fps: number) => {
      const c = project.addComp(name, w, h, dur);
      c.pixelAspect = pa;
      c.frameRate = fps;
      return c;
    },
  };
  return project;
}

describe("scrub.jsx in the simulated AE", () => {
  it("reads the comp's work area, markers and visible layers' edges without touching anything", () => {
    const project = withItems(new FakeProject());
    const comp = project.addComp("Main", 640, 360, 4);
    comp.workAreaStart = 1;
    comp.workAreaDuration = 2;
    comp.markerProperty.setValueAtTime(1.5, new MarkerValue("cut"));
    const a = comp.layers.addSolid([1, 0, 0], "A", 640, 360, 1, 4);
    a.inPoint = 0.5;
    a.outPoint = 3;
    const hidden = comp.layers.addSolid([0, 1, 0], "Hidden", 640, 360, 1, 4);
    hidden.enabled = false;
    comp.layers.addCamera("Cam");
    comp.layers.addNull(2).name = "TheNull";
    const guide = comp.layers.addSolid([0, 0, 1], "Guide", 640, 360, 1, 4);
    guide.guideLayer = true;
    const { A, undo, G } = loadHost(project, ["scrub.jsx"]);
    // the fake has no CameraLayer / LightLayer globals; AE does
    G.CameraLayer = { [Symbol.hasInstance]: (l: any) => l.reflect.name === "CameraLayer" };
    G.LightLayer = { [Symbol.hasInstance]: (l: any) => l.reflect.name === "LightLayer" };
    const info = A.scrubInfo({ comp_id: comp.id });
    expect(info).toMatchObject({ comp_id: comp.id, name: "Main", width: 640, height: 360, duration: 4, workAreaStart: 1, workAreaDuration: 2, numLayers: 5 });
    expect(info.frameDuration).toBeCloseTo(0.04, 9);
    expect(info.markers).toEqual([{ time: 1.5, comment: "cut" }]);
    const edges = info.layer_edges.map((e: { layer: string; edge: string; time: number }) => `${e.layer}:${e.edge}:${e.time}`);
    expect(edges).toContain("A:in:0.5");
    expect(edges).toContain("A:out:3");
    expect(edges.some((e: string) => e.startsWith("Hidden") || e.startsWith("Cam") || e.startsWith("TheNull") || e.startsWith("Guide"))).toBe(false);
    expect(info.markers_truncated).toBe(false);
    expect(undo.begun).toBe(0);
    expect(project.dirty).toBe(false);
    expect(() => A.scrubInfo({ comp_id: 99999 })).toThrow(/No CompItem/);
  });

  it("imports a render into a temporary comp in one undo group, then removes both", () => {
    const project = withItems(new FakeProject());
    const { A, undo } = loadHost(project, ["scrub.jsx"]);
    const file = path.join(tempDir("chroma-scrub-jsx-"), "out_64x36_25fps_50f.mov");
    fs.writeFileSync(file, "x");
    const imp = A.scrubImport({ path: file, expect: GUARD });
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    expect(imp).toMatchObject({ width: 64, height: 36, frameRate: 25, duration: 2, sequence: false });
    const comp = project.itemByID(imp.comp_id) as any;
    expect(comp.name).toBe("Scrub check (temp)");
    expect(comp.numLayers).toBe(1);
    expect(comp.layer(1).source.id).toBe(imp.item_id);
    expect(comp.frameRate).toBe(25);
    // a separate read sees both
    expect(A.scrubState({ item_id: imp.item_id, comp_id: imp.comp_id })).toMatchObject({ item: { id: imp.item_id }, comp: { id: imp.comp_id, numLayers: 1 } });
    const gone = A.scrubRemove({ item_id: imp.item_id, comp_id: imp.comp_id, expect: GUARD });
    expect(gone).toEqual({ removed_comp: imp.comp_id, removed_item: imp.item_id, item_kept: false });
    expect(undo).toMatchObject({ begun: 2, ended: 2 });
    expect(A.scrubState({ item_id: imp.item_id, comp_id: imp.comp_id })).toEqual({ item: null, comp: null });
    expect(project.numItems).toBe(0);
  });

  it("removes the item even when usedIn still lists the removed temporary comp", () => {
    const project = withItems(new FakeProject());
    const { A } = loadHost(project, ["scrub.jsx"]);
    const file = path.join(tempDir("chroma-scrub-jsx-stale-"), "out_64x36_25fps_50f.mov");
    fs.writeFileSync(file, "x");
    const imp = A.scrubImport({ path: file, expect: GUARD });
    const item = project.itemByID(imp.item_id) as any;
    const tempComp = project.itemByID(imp.comp_id) as any;
    // a stale read: usedIn keeps naming the comp after it is removed
    Object.defineProperty(item, "usedIn", { get: () => [tempComp] });
    const gone = A.scrubRemove({ item_id: imp.item_id, comp_id: imp.comp_id, expect: GUARD });
    expect(gone).toEqual({ removed_comp: imp.comp_id, removed_item: imp.item_id, item_kept: false });
  });

  it("imports a sequence with numbered order, and conforms its frame rate", () => {
    const project = withItems(new FakeProject());
    const { A } = loadHost(project, ["scrub.jsx"]);
    const file = path.join(tempDir("chroma-scrub-jsx-seq-"), "s_64x36_30fps_30f_0001.png");
    fs.writeFileSync(file, "x");
    let seen: any = null;
    const real = project.importFile.bind(project);
    project.importFile = (io: any) => {
      seen = io;
      const item = real(io);
      item.mainSource.conformFrameRate = 30;
      return item;
    };
    const imp = A.scrubImport({ path: file, sequence: true, fps: 24, expect: GUARD });
    expect(seen.sequence).toBe(true);
    expect(seen.forceAlphabetical).toBe(false);
    expect((project.itemByID(imp.item_id) as any).mainSource.conformFrameRate).toBe(24);
  });

  it("conforms a sequence without re-reading the item: the comp gets the new rate and the same frames", () => {
    const project = withItems(new FakeProject());
    const { A } = loadHost(project, ["scrub.jsx"]);
    const file = path.join(tempDir("chroma-scrub-jsx-conf-"), "c_64x36_30fps_48f_0001.png");
    fs.writeFileSync(file, "x");
    const imp = A.scrubImport({ path: file, sequence: true, fps: 60, expect: GUARD });
    expect(imp.frameRate).toBe(60);
    expect(imp.duration).toBeCloseTo(0.8, 9);
    expect((project.itemByID(imp.comp_id) as any).frameRate).toBe(60);
    // 100 and 120 fps renders are fine
    const hi = path.join(tempDir("chroma-scrub-jsx-hi-"), "h_64x36_120fps_240f.mov");
    fs.writeFileSync(hi, "x");
    expect(A.scrubImport({ path: hi, expect: GUARD })).toMatchObject({ frameRate: 120, duration: 2 });
    // the state read reports rate and length for the separate check
    expect(A.scrubState({ item_id: imp.item_id, comp_id: imp.comp_id })).toMatchObject({ item: { frameRate: expect.any(Number), duration: expect.any(Number) }, comp: { frameRate: 60 } });
  });

  it("refuses before importing: a failed guard, a missing file, a bad frame rate", () => {
    const project = withItems(new FakeProject());
    const { A, undo } = loadHost(project, ["scrub.jsx"]);
    expect(() => A.scrubImport({ path: "C:/nope.mov", expect: { project_path: "C:/other.aep" } })).toThrow(/guard refused/);
    expect(() => A.scrubImport({ path: "C:/nope.mov", expect: GUARD })).toThrow(/No render/);
    const file = path.join(tempDir("chroma-scrub-jsx-bad-"), "x_64x36_25fps_50f.mov");
    fs.writeFileSync(file, "x");
    expect(() => A.scrubImport({ path: file, sequence: true, fps: 1500, expect: GUARD })).toThrow(/fps must be/);
    expect(project.numItems).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("takes the import back out in the same group when it can't build the comp", () => {
    const project = withItems(new FakeProject());
    const { A, undo } = loadHost(project, ["scrub.jsx"]);
    const dir = tempDir("chroma-scrub-jsx-roll-");
    // a still
    const still = path.join(dir, "logo_64x36_25fps_1f.png");
    fs.writeFileSync(still, "x");
    const real = project.importFile.bind(project);
    project.importFile = (io: any) => {
      const item = real(io);
      item.mainSource.isStill = true;
      return item;
    };
    expect(() => A.scrubImport({ path: still, expect: GUARD })).toThrow(/single still/);
    expect(project.numItems).toBe(0);
    project.importFile = real;
    // a frame rate a comp can't have
    const odd = path.join(dir, "odd_64x36_1200fps_50f.mov");
    fs.writeFileSync(odd, "x");
    expect(() => A.scrubImport({ path: odd, expect: GUARD })).toThrow(/frame rate/);
    expect(project.numItems).toBe(0);
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
  });

  it("removes only the temporary comp it built, and keeps an item something else uses", () => {
    const project = withItems(new FakeProject());
    const mine = project.addComp("Main", 64, 36, 2);
    const { A } = loadHost(project, ["scrub.jsx"]);
    expect(() => A.scrubRemove({ comp_id: mine.id, expect: GUARD })).toThrow(/not the temporary comp/);
    expect(project.itemByID(mine.id)).not.toBeNull();
    const file = path.join(tempDir("chroma-scrub-jsx-keep-"), "k_64x36_25fps_50f.mov");
    fs.writeFileSync(file, "x");
    const imp = A.scrubImport({ path: file, expect: GUARD });
    // the user used the footage in their own comp meanwhile
    mine.layers.add(project.itemByID(imp.item_id));
    const out = A.scrubRemove({ item_id: imp.item_id, comp_id: imp.comp_id, expect: GUARD });
    expect(out).toEqual({ removed_comp: imp.comp_id, removed_item: null, item_kept: true });
    expect(project.itemByID(imp.item_id)).not.toBeNull();
    expect(project.itemByID(imp.comp_id)).toBeNull();
    // already gone: nothing to do, no error
    expect(A.scrubRemove({ item_id: 123456, comp_id: 654321, expect: GUARD })).toEqual({ removed_comp: null, removed_item: null, item_kept: false });
  });
});
