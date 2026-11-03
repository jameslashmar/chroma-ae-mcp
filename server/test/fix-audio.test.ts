/**
 * Regression tests for the audio review fixes: decoding limits and malformed
 * headers, the event-loop yield, the onset floor, exact level steps, cue-key
 * planning and read-back, the cue-key host function, and the tool's inputs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeAudio, AudioDecodeError, decodeAudio } from "../src/audio.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeAudioAnalyzeSchema, createAudioTools, cueKeysMismatches, planCueKeys } from "../src/tools/ext/audio.js";
import { FakeGroup, FakeProject, FakeProperty, GUARD, KeyframeEase, loadHost, PropertyValueType } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- fixtures ----------

/** A RIFF/WAVE: 16-bit PCM mono, with the data chunk size and RIFF size given (and extra chunks after it). */
function wavBytes(opts: { sampleRate: number; samples: Buffer; dataSize?: number; riffSize?: number; trailing?: Buffer; bits?: number }): Buffer {
  const bits = opts.bits ?? 16;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(opts.sampleRate, 12);
  fmt.writeUInt32LE((opts.sampleRate * bits) / 8, 16);
  fmt.writeUInt16LE(bits / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(opts.riffSize ?? 4 + fmt.length + 8 + opts.samples.length, 4);
  head.write("WAVE", 8, "latin1");
  const dh = Buffer.alloc(8);
  dh.write("data", 0, "latin1");
  dh.writeUInt32LE(opts.dataSize ?? opts.samples.length, 4);
  return Buffer.concat([head, fmt, dh, opts.samples, opts.trailing ?? Buffer.alloc(0)]);
}

function aiffBytes(channels: number, frames: number, sampleRate = 8000): Buffer {
  const comm = Buffer.alloc(26);
  comm.write("COMM", 0, "latin1");
  comm.writeUInt32BE(18, 4);
  comm.writeInt16BE(channels, 8);
  comm.writeUInt32BE(frames, 10);
  comm.writeInt16BE(16, 14);
  const e = Math.floor(Math.log2(sampleRate));
  comm.writeUInt16BE(16383 + e, 16);
  comm.writeBigUInt64BE(BigInt(sampleRate) << BigInt(63 - e), 18);
  const ssnd = Buffer.alloc(16 + 64);
  ssnd.write("SSND", 0, "latin1");
  ssnd.writeUInt32BE(8 + 64, 4);
  const form = Buffer.alloc(12);
  form.write("FORM", 0, "latin1");
  form.writeUInt32BE(4 + comm.length + ssnd.length, 4);
  form.write("AIFF", 8, "latin1");
  return Buffer.concat([form, comm, ssnd]);
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

// ---------- decoding ----------

describe("decodeAudio limits and malformed headers", () => {
  it("refuses audio over maxSeconds from the header, before mixing it down", () => {
    // 21 minutes of 16-bit mono at 100 Hz.
    const buf = wavBytes({ sampleRate: 100, samples: Buffer.alloc(21 * 60 * 100 * 2) });
    expect(() => decodeAudio(buf, { maxSeconds: 20 * 60 })).toThrow(/at most 20 minutes/);
    expect(decodeAudio(buf).frames).toBe(21 * 60 * 100);
    // The length is judged from the header: no Float32Array of that many frames is made first.
    const real = Float32Array;
    let made = 0;
    (globalThis as any).Float32Array = class extends real {
      constructor(...a: any[]) {
        super(...(a as [number]));
        if (typeof a[0] === "number") made = Math.max(made, a[0]);
      }
    };
    try {
      expect(() => decodeAudio(buf, { maxSeconds: 20 * 60 })).toThrow(AudioDecodeError);
    } finally {
      (globalThis as any).Float32Array = real;
    }
    expect(made).toBe(0);
  });

  it("turns a truncated fmt chunk into an AudioDecodeError", () => {
    const buf = wavBytes({ sampleRate: 8000, samples: Buffer.alloc(8) }).subarray(0, 12 + 8 + 6);
    expect(() => decodeAudio(buf)).toThrow(AudioDecodeError);
  });

  it("refuses an AIFF with zero channels or a truncated COMM chunk", () => {
    expect(() => decodeAudio(aiffBytes(0, 4800))).toThrow(AudioDecodeError);
    expect(decodeAudio(aiffBytes(1, 16)).frames).toBe(16);
    expect(() => decodeAudio(aiffBytes(1, 16).subarray(0, 12 + 8 + 10))).toThrow(AudioDecodeError);
  });

  it("does not read the chunks after an empty data chunk as samples", () => {
    const trailing = Buffer.concat([Buffer.from("LIST", "latin1"), Buffer.from([100, 0, 0, 0]), Buffer.alloc(100, 0x7f)]);
    const buf = wavBytes({ sampleRate: 8000, samples: Buffer.alloc(0), dataSize: 0, trailing });
    expect(() => decodeAudio(buf)).toThrow(/no audio data/);
  });

  it("still reads a streaming WAV whose sizes are left at 0", () => {
    const samples = Buffer.alloc(40);
    samples.writeInt16LE(16384, 2);
    const buf = wavBytes({ sampleRate: 8000, samples, dataSize: 0, riffSize: 0 });
    const d = decodeAudio(buf);
    expect(d.frames).toBe(20);
    expect(d.mono[1]).toBeCloseTo(0.5, 3);
  });
});

// ---------- analysis ----------

describe("analyzeAudio", () => {
  it("yields to the event loop while it works", async () => {
    const sr = 44100;
    const rnd = lcg(3);
    const mono = Float32Array.from({ length: sr * 30 }, () => rnd() * 0.1);
    let finished = false;
    let tickedBefore = false;
    setImmediate(() => {
      tickedBefore = !finished;
    });
    await analyzeAudio(mono, sr).then(() => {
      finished = true;
    });
    expect(tickedBefore).toBe(true);
  });

  it("gives near-silent noise no onsets, tempo or beats", async () => {
    const sr = 44100;
    const rnd = lcg(11);
    const quiet = Float32Array.from({ length: sr * 10 }, () => rnd() * 1e-4); // about -80 dBFS
    const a = await analyzeAudio(quiet, sr);
    expect(a.overall.silent_ratio).toBe(1);
    expect(a.onsets).toEqual([]);
    expect(a.tempo).toBeNull();
    expect(a.beats).toEqual([]);
    expect(a.hits).toEqual([]);
  });

  it("puts level points on exact comp frames with an unrounded step", async () => {
    const sr = 48000;
    const mono = new Float32Array(sr * 16).fill(0.1);
    const a = await analyzeAudio(mono, sr, { fps: 30, levels: true });
    expect(a.levels!.rms_db.length).toBe(480);
    expect(a.levels!.frames_per_point).toBe(1);
    expect(a.levels!.fps).toBe(30);
    expect(a.levels!.step).toBeCloseTo(1 / 30, 6);
    expect(a.levels!.step).not.toBe(0.033);
    const b = await analyzeAudio(mono, 44100, { fps: 29.97, levels: true });
    expect(b.levels!.step).toBeCloseTo(b.levels!.frames_per_point / 29.97, 6);
  });
});

// ---------- cue key plan ----------

describe("planCueKeys", () => {
  const frame = 1 / 25;

  it("settles one frame after the cue when decay is 0", () => {
    const keys = planCueKeys([1, 2, 3], { attack: 0, decay: 0, frame, peak: 1 });
    expect(keys.map((k) => [k.kind, k.time])).toEqual([
      ["pre", 0.96],
      ["peak", 1],
      ["post", 1.04],
      ["pre", 1.96],
      ["peak", 2],
      ["post", 2.04],
      ["pre", 2.96],
      ["peak", 3],
      ["post", 3.04],
    ]);
  });

  it("starts the first cue from base at 0 when it is closer to 0 than its attack", () => {
    const keys = planCueKeys([0.2], { attack: 0.3, decay: 0.1, frame, peak: 1 });
    expect(keys.map((k) => [k.kind, k.time])).toEqual([
      ["pre", 0],
      ["peak", 0.2],
      ["post", 0.3],
    ]);
    // Only the first cue: a later one with a long attack does not put base at 0 after the first peak.
    const two = planCueKeys([0.1, 0.2], { attack: 0.3, decay: 0.1, frame, peak: 1 });
    expect(two.filter((k) => k.time === 0).length).toBe(1);
    expect(two[0].kind).toBe("pre");
    // A cue within half a frame of 0 needs no base key.
    expect(planCueKeys([0.01], { attack: 0, decay: 0.1, frame, peak: 1 })[0].kind).toBe("peak");
  });
});

describe("cueKeysMismatches with a truncated read-back", () => {
  const planned = planCueKeys([1, 2, 3], { attack: 0, decay: 0.2, frame: 0.04, peak: 50 });

  it("does not pass silently: reports what it could not verify", () => {
    const after = { numKeys: 9, truncated: true, keys: [{ index: 1, time: 0.96, value: 0 }, { index: 2, time: 1, value: 50 }, { index: 3, time: 1.2, value: 0 }] };
    const m = cueKeysMismatches(planned, after, { base: 0 });
    expect(m.map((x) => x.path)).toEqual(["keys"]);
    expect(m[0].message).toMatch(/6 planned key\(s\) .* not verified/);
  });

  it("still checks the keys that were read", () => {
    const after = { numKeys: 9, truncated: true, keys: [{ index: 1, time: 0.96, value: 0 }, { index: 2, time: 1, value: 40 }, { index: 3, time: 1.2, value: 0 }] };
    expect(cueKeysMismatches(planned, after, { base: 0 }).map((x) => x.path)).toEqual(["keys", "keys@1"]);
  });
});

// ---------- the tool ----------

function fakeAe(results: Record<string, unknown[]>) {
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-fixaudio-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx };
}

const compInfo = (extra: object = {}) => ({
  comp_id: 1,
  name: "Edit",
  name_unique: true,
  duration: 4,
  fps: 25,
  frame_duration: 0.04,
  display_start_time: 0,
  audio_layers: [{ index: 2, name: "Music" }],
  project_path: "C:/p/x.aep",
  dirty: false,
  ...extra,
});

describe("ae_audio_analyze inputs", () => {
  it("rejects min_bpm that is not below max_bpm, counting the defaults", () => {
    const ok = (a: object) => AeAudioAnalyzeSchema.safeParse({ audio_path: "/x.wav", ...a }).success;
    expect(ok({ min_bpm: 250 })).toBe(false);
    expect(ok({ min_bpm: 150, max_bpm: 100 })).toBe(false);
    expect(ok({ max_bpm: 50 })).toBe(false);
    expect(ok({ min_bpm: 80, max_bpm: 160 })).toBe(true);
    expect(ok({})).toBe(true);
  });

  it("takes fps only with audio_path, and uses it for the levels", async () => {
    expect(AeAudioAnalyzeSchema.safeParse({ comp_id: 1, expect: { project_path: "x" }, fps: 30 }).success).toBe(false);
    const file = path.join(tempDir("chroma-fixaudio-fps-"), "a.wav");
    fs.writeFileSync(file, wavBytes({ sampleRate: 8000, samples: Buffer.alloc(8000 * 2 * 2) }));
    const { ctx } = fakeAe({});
    const out = await createAudioTools()[0].handler(AeAudioAnalyzeSchema.parse({ audio_path: file, fps: 30, levels: true }), ctx);
    expect(out.ok).toBe(true);
    expect(out.levels).toMatchObject({ fps: 30, frames_per_point: 1 });
    expect(out.levels.step).toBeCloseTo(1 / 30, 6);
  });

  it("offsets the analysis by the frame the render really starts on", async () => {
    const dir = tempDir("chroma-fixaudio-offset-");
    let output = "";
    const started: Array<Record<string, unknown>> = [];
    const tools = createAudioTools({
      rendersDir: () => dir,
      pollMs: 5,
      startRender: async (args) => {
        started.push(args);
        output = String(args.output_path);
        fs.writeFileSync(output, wavBytes({ sampleRate: 8000, samples: Buffer.alloc(8000 * 2) }));
        return { ok: true, job_id: "job_o" };
      },
      getJob: () => ({ state: "succeeded", output_path: output, log_path: "x.log" }),
    });
    const { ctx } = fakeAe({ audioCompInfo: [compInfo()] });
    const args = AeAudioAnalyzeSchema.parse({ comp_id: 1, start: 1.03, end: 2, expect: { project_path: "C:/p/x.aep" } });
    const out = await tools[0].handler(args, ctx);
    expect(started[0]).toMatchObject({ start_frame: 26 });
    expect(out.time_offset).toBeCloseTo(1.04, 6);
  });

  it("refuses a render range over 20 minutes before starting aerender", async () => {
    let started = 0;
    const tools = createAudioTools({
      rendersDir: () => tempDir("chroma-fixaudio-long-"),
      startRender: async () => {
        started++;
        return { job_id: "never" };
      },
    });
    const { ctx } = fakeAe({ audioCompInfo: [compInfo({ duration: 3600 })] });
    const out = await tools[0].handler(AeAudioAnalyzeSchema.parse({ comp_id: 1, expect: { project_path: "C:/p/x.aep" } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "too_long" });
    expect(started).toBe(0);
  });

  it("reports audio over 20 minutes as bad_audio from the header", async () => {
    const file = path.join(tempDir("chroma-fixaudio-big-"), "long.wav");
    fs.writeFileSync(file, wavBytes({ sampleRate: 100, samples: Buffer.alloc(21 * 60 * 100 * 2) }));
    const { ctx } = fakeAe({});
    const out = await createAudioTools()[0].handler(AeAudioAnalyzeSchema.parse({ audio_path: file }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_audio" });
  });
});

// ---------- the cueKeys host function ----------

describe("audio.jsx cueKeys", () => {
  const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
  const SCALE = ["ADBE Transform Group", "ADBE Scale"];

  function setup() {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const { A, undo } = loadHost(project, ["layers.jsx", "keyframes.jsx", "audio.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Ball", expect: GUARD });
    const ball = comp.layer("Ball")!;
    const add = (p: FakeProperty) => {
      (ball.group as FakeGroup).props.push(p);
      p.parentProperty = ball.group as FakeGroup;
      return p;
    };
    const call = (path: string[], extra: object) =>
      A.cueKeys({ comp_id: comp.id, layer: { name: "Ball" }, path, keys: [{ time: 1, value: 40 }, { time: 1.2, value: null }], expect: GUARD, ...extra });
    return { comp, A, undo, ball, add, call, opacity: ball.transform("ADBE Opacity"), scale: ball.transform("ADBE Scale") };
  }

  it("refuses a wrong value shape before it removes any key", () => {
    const { call, opacity, scale } = setup();
    opacity.setValuesAtTimes([0.5, 1, 1.1, 3], [10, 20, 30, 40]);
    const before = opacity.numKeys;
    expect(() => call(OPACITY, { keys: [{ time: 1, value: [100, 100] }, { time: 1.2, value: null }], clear_range: [0.5, 3] })).toThrow(/does not fit/);
    expect(opacity.numKeys).toBe(before);
    scale.setValuesAtTimes([0.5, 3], [[1, 1, 1], [2, 2, 2]]);
    expect(() => call(SCALE, { keys: [{ time: 1, value: 115 }, { time: 1.2, value: null }], clear_range: [0.5, 3] })).toThrow(/is not a number|does not fit/);
    expect(() => call(SCALE, { keys: [{ time: 1, value: [115, 115, 115, 115] }], clear_range: [0.5, 3] })).toThrow(/does not fit/);
    expect(() => call(OPACITY, { base: [1, 2], clear_range: [0.5, 3] })).toThrow(/base does not fit/);
    expect(scale.numKeys).toBe(2);
    expect(opacity.numKeys).toBe(before);
  });

  it("takes a 2-value peak on Scale and a one-value array on a one-value property", () => {
    const { call, scale, opacity } = setup();
    const r = call(SCALE, { keys: [{ time: 1, value: [115, 115] }, { time: 1.2, value: null }] });
    expect(r.set).toBe(2);
    expect(scale.numKeys).toBe(2);
    call(OPACITY, { keys: [{ time: 1, value: [40] }, { time: 1.2, value: null }] });
    expect(opacity.keyValue(1)).toBe(40);
  });

  it("refuses a property with no numeric value", () => {
    const { call, add } = setup();
    add(new FakeProperty("Doc", "ADBE Text Document", PropertyValueType.TEXT_DOCUMENT, null));
    expect(() => call(["Doc"], {})).toThrow(/does not take a numeric value/);
  });

  it("sets the ease with the length AE reports, for a colour too", () => {
    const { call, add } = setup();
    const color = add(new FakeProperty("Tint", "ADBE Tint Color", PropertyValueType.COLOR, [1, 0, 0, 1]));
    color.setTemporalEaseAtKey = function (this: FakeProperty, i: number, inE: KeyframeEase[], outE?: KeyframeEase[]) {
      if (inE.length !== 1) throw new Error("ease length must be 1");
      FakeProperty.prototype.setTemporalEaseAtKey.call(this, i, inE, outE);
    };
    const r = call(["Tint"], { keys: [{ time: 1, value: [0, 1, 0, 1] }, { time: 1.2, value: null }] });
    expect(r).toMatchObject({ set: 2, ease_warning: null });
    expect(color.keyOutTemporalEase(1)[0].influence).toBeCloseTo(33.333, 2);
  });

  it("falls back through the likely lengths when AE cannot say", () => {
    const { call, add } = setup();
    const p = add(new FakeProperty("Pair", "Pair", PropertyValueType.OneD, 0));
    p.keyInTemporalEase = () => {
      throw new Error("no ease info");
    };
    p.setTemporalEaseAtKey = function (this: FakeProperty, i: number, inE: KeyframeEase[], outE?: KeyframeEase[]) {
      if (inE.length !== 2) throw new Error("ease length must be 2");
      FakeProperty.prototype.setTemporalEaseAtKey.call(this, i, inE, outE);
    };
    const r = call(["Pair"], { keys: [{ time: 1, value: 5 }, { time: 1.2, value: null }] });
    expect(r.ease_warning).toBeNull();
    expect(p.keyOutTemporalEase(1).length).toBe(2);
  });

  it("keeps the keys and reports a warning when the ease is rejected", () => {
    const { call, add, undo } = setup();
    const p = add(new FakeProperty("Odd", "Odd", PropertyValueType.OneD, 0));
    p.setTemporalEaseAtKey = () => {
      throw new Error("nope");
    };
    const r = call(["Odd"], {});
    expect(r.set).toBe(2);
    expect(p.numKeys).toBe(2);
    expect(r.ease_warning).toMatch(/Ease not applied/);
    expect(undo.begun).toBe(undo.ended);
  });

  it("leaves a hold-only property's keys as hold, with a note instead of an error", () => {
    const { call, add } = setup();
    const p = add(new FakeProperty("Check", "ADBE Checkbox", PropertyValueType.OneD, 0)) as FakeProperty & { isInterpolationTypeValid: (t: number) => boolean };
    p.isInterpolationTypeValid = () => false;
    p.setInterpolationTypeAtKey = () => {
      throw new Error("hold keys only");
    };
    const r = call(["Check"], { keys: [{ time: 1, value: 1 }, { time: 1.2, value: 0 }] });
    expect(r.set).toBe(2);
    expect(p.numKeys).toBe(2);
    expect(r.ease_warning).toMatch(/only takes hold keys/);
  });

  it("keysSnapshot reads up to the asked cap, never past 1500", () => {
    const { A, comp, opacity } = setup();
    const times = Array.from({ length: 600 }, (_, i) => i * 0.001);
    opacity.setValuesAtTimes(times, times.map((_, i) => i % 100));
    const snap = (extra: object) => A.keysSnapshot({ comp_id: comp.id, layer: { name: "Ball" }, path: OPACITY, ...extra });
    expect(snap({}).truncated).toBe(true);
    expect(snap({}).keys.length).toBe(500);
    const more = snap({ max: 1500 });
    expect(more.truncated).toBe(false);
    expect(more.keys.length).toBe(600);
    expect(snap({ max: 100000 }).keys.length).toBe(600);
  });
});

describe("ae_cue_keys 1-element peak/base", () => {
  it("plans plain numbers so the receipt has no mismatches", async () => {
    const tool = createAudioTools().find((t) => t.name === "ae_cue_keys")!;
    const ctx = {
      bridge: {
        callHost: async () => ({ result: { frame_duration: 0.04, fps: 25 } }),
      },
    } as unknown as ToolContext;
    const out: any = await tool.handler({ comp_id: 1, layer: 1, path: "Transform/Opacity", times: [1], peak: [40], base: [0], dry_run: true }, ctx);
    expect(out.keys.map((k: any) => k.value)).toEqual([0, 40, 0]);
    const after = { numKeys: 3, truncated: false, keys: out.keys.map((k: any, i: number) => ({ index: i + 1, time: k.time, value: k.value })) };
    expect(cueKeysMismatches(out.keys, after, { base: 0 })).toEqual([]);
  });
});
