import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAudio, decodeAudioChannels } from "../src/audio.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  applyHint,
  AeLoudnessApplySchema,
  AeLoudnessCheckSchema,
  assessLoudness,
  channelPeak,
  channelWeights,
  createLoudnessTools,
  gatedLoudness,
  isFloatFormat,
  kWeighting,
  levelsMismatches,
  loudnessRange,
  loudnessTools,
  makePolyphase,
  measureLoudness,
  oversamplingFor,
  pruneOldRenders,
  decodedBudget,
  quantile,
  resolveStandard,
  STANDARDS,
  type LoudnessMeasurement,
} from "../src/tools/ext/loudness.js";
import { FakeGroup, FakeProject, FakeProperty, GUARD, PropertyValueType, loadHost, type FakeComp, type FakeLayer } from "./support/fake-ae.js";

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

/** A sine at `dbfs` per channel, the same in every channel. */
function tone(freq: number, dbfs: number, seconds: number, rate = 48000, channels = 2): Float32Array[] {
  const amp = 10 ** (dbfs / 20);
  const n = Math.round(seconds * rate);
  return Array.from({ length: channels }, () => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    return x;
  });
}

const concat = (...parts: Float32Array[][]): Float32Array[] =>
  parts[0].map((_, c) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p[c].length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p[c], at);
      at += p[c].length;
    }
    return out;
  });

function wav16(samples: Float32Array[], sampleRate: number): Buffer {
  const channels = samples.length;
  const frames = samples[0].length;
  const data = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[c][f] * 32767))), (f * channels + c) * 2);
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  const dh = Buffer.alloc(8);
  dh.write("data", 0, "latin1");
  dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dh, data]);
}

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-loud-q-"), "quarantine.json"));
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
  return { ctx, calls, host };
}

const expectArg = { project_path: "<unsaved>" };
const tool = (name: string, tools = loudnessTools) => tools.find((t) => t.name === name)!;

const lv = (value: number[] | null, extra: Record<string, unknown> = {}) => ({
  value,
  num_keys: 0,
  keys: [],
  keys_truncated: false,
  min: -192,
  max: 24,
  expression: false,
  ...extra,
});
const soundLayer = (index: number, id: number, name: string, levels: unknown, extra: Record<string, unknown> = {}) => ({
  index,
  id,
  name,
  kind: "footage",
  audio_enabled: true,
  locked: false,
  inPoint: 0,
  outPoint: 4,
  levels,
  ...extra,
});
const compInfo = (layers: unknown[], extra: Record<string, unknown> = {}) => ({
  comp_id: 1,
  name: "Edit",
  name_unique: true,
  duration: 4,
  fps: 25,
  frame_duration: 0.04,
  display_start_time: 0,
  layers,
  truncated: false,
  project_path: "C:/p/x.aep",
  dirty: false,
  ...extra,
});

// ---------- DSP ----------

describe("K-weighting", () => {
  it("reproduces the coefficients BS.1770-4 prints for 48 kHz", () => {
    const { stage1, stage2 } = kWeighting(48000);
    expect(stage1.b[0]).toBeCloseTo(1.53512485958697, 6);
    expect(stage1.b[1]).toBeCloseTo(-2.69169618940638, 6);
    expect(stage1.b[2]).toBeCloseTo(1.19839281085285, 6);
    expect(stage1.a[1]).toBeCloseTo(-1.69065929318241, 6);
    expect(stage1.a[2]).toBeCloseTo(0.73248077421585, 6);
    expect(stage2.a[1]).toBeCloseTo(-1.99004745483398, 6);
    expect(stage2.a[2]).toBeCloseTo(0.99007225036621, 6);
  });

  it("derives stable filters for other rates", () => {
    for (const rate of [8000, 44100, 96000, 192000]) {
      const { stage1, stage2 } = kWeighting(rate);
      for (const f of [stage1, stage2]) {
        // Poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
        expect(Math.abs(f.a[2])).toBeLessThan(1);
        expect(Math.abs(f.a[1])).toBeLessThan(1 + f.a[2]);
      }
    }
  });

  it("derives filters whose response matches the 48 kHz one at the other rates", () => {
    const mag = (b: number[], a: number[], f: number, fs: number) => {
      const w = (2 * Math.PI * f) / fs;
      const re = (c: number[]) => c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
      const im = (c: number[]) => -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
      return 20 * Math.log10(Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a)));
    };
    const resp = (rate: number, f: number, designedFor = rate) => {
      const k = kWeighting(designedFor);
      return mag(k.stage1.b, k.stage1.a, f, rate) + mag(k.stage2.b, k.stage2.a, f, rate);
    };
    expect(resp(48000, 1000)).toBeCloseTo(0.7, 1);
    expect(resp(48000, 10000)).toBeCloseTo(4.04, 1);
    for (const rate of [44100, 96000]) {
      for (const f of [30, 100, 2000, 5000, 10000]) {
        expect(Math.abs(resp(rate, f) - resp(48000, f))).toBeLessThan(0.05);
      }
    }
    // The check has teeth: the 48 kHz coefficients used at 44.1 kHz are off by more than that.
    expect(Math.abs(resp(44100, 30, 48000) - resp(48000, 30))).toBeGreaterThan(0.2);
    expect(Math.abs(resp(44100, 2000, 48000) - resp(48000, 2000))).toBeGreaterThan(0.1);
  });

  it("weights channels as BS.1770 does and picks the oversampling", () => {
    expect(channelWeights(1)).toEqual([1]);
    expect(channelWeights(2)).toEqual([1, 1]);
    expect(channelWeights(6)).toEqual([1, 1, 1, 0, 1.41, 1.41]);
    expect(oversamplingFor(44100)).toBe(4);
    expect(oversamplingFor(48000)).toBe(4);
    expect(oversamplingFor(96000)).toBe(2);
    expect(oversamplingFor(192000)).toBe(1);
  });
});

describe("measureLoudness", () => {
  it("reads a stereo 997 Hz tone at -23 dBFS as -23.0 LUFS (EBU Tech 3341 case 1)", async () => {
    const m = await measureLoudness(tone(997, -23, 20), 48000);
    expect(m.integrated_lufs).toBeGreaterThanOrEqual(-23.1);
    expect(m.integrated_lufs).toBeLessThanOrEqual(-22.9);
    expect(m.momentary_max_lufs).toBeCloseTo(-23, 0);
    expect(m.short_term_max_lufs).toBeCloseTo(-23, 0);
    expect(m.true_peak_dbtp).toBeCloseTo(-23, 0);
    expect(m.clipped_samples).toBe(0);
    expect(m.blocks.gated).toBe(m.blocks.total);
  });

  it("sums the channels' energy: one channel alone reads 3 dB lower than two", async () => {
    const both = await measureLoudness(tone(997, -23, 10, 48000, 2), 48000);
    const one = await measureLoudness(tone(997, -23, 10, 48000, 1), 48000);
    expect(both.integrated_lufs! - one.integrated_lufs!).toBeCloseTo(3, 0);
  });

  it("works at 44.1 kHz too", async () => {
    const m = await measureLoudness(tone(997, -20, 10, 44100), 44100);
    expect(m.integrated_lufs).toBeGreaterThanOrEqual(-20.15);
    expect(m.integrated_lufs).toBeLessThanOrEqual(-19.85);
  });

  it("reads low and high tones the same at 44.1 and 48 kHz (the filters are derived per rate)", async () => {
    for (const freq of [40, 4000]) {
      const a = await measureLoudness(tone(freq, -20, 6, 48000), 48000);
      const b = await measureLoudness(tone(freq, -20, 6, 44100), 44100);
      expect(Math.abs(a.integrated_lufs! - b.integrated_lufs!)).toBeLessThan(0.1);
    }
  });

  it("gates out quiet passages: -20 then -50 LUFS reads -20 (relative gate)", async () => {
    const m = await measureLoudness(concat(tone(997, -20, 10), tone(997, -50, 10)), 48000);
    expect(m.integrated_lufs).toBeGreaterThanOrEqual(-20.1);
    expect(m.integrated_lufs).toBeLessThanOrEqual(-19.9);
    expect(m.blocks.gated).toBeLessThan(m.blocks.above_absolute_gate);
  });

  it("reads a loudness range of about 10 LU for 30 s at -20 and 30 s at -30 (EBU Tech 3342)", async () => {
    const m = await measureLoudness(concat(tone(997, -20, 30), tone(997, -30, 30)), 48000);
    expect(m.loudness_range_lu).toBeGreaterThanOrEqual(9.7);
    expect(m.loudness_range_lu).toBeLessThanOrEqual(10.3);
    expect(m.loudest_window!.lufs).toBeCloseTo(-20, 0);
    expect(m.quietest_window!.lufs).toBeCloseTo(-30, 0);
    expect(m.quietest_window!.start).toBeGreaterThan(m.loudest_window!.start);
    expect(m.loudest_window!.kind).toBe("short_term_3s");
  });

  it("has no range under 3 s, and falls back to 400 ms windows", async () => {
    const m = await measureLoudness(tone(997, -23, 1), 48000);
    expect(m.loudness_range_lu).toBeNull();
    expect(m.short_term_max_lufs).toBeNull();
    expect(m.loudest_window).toMatchObject({ kind: "momentary_400ms", end: expect.any(Number) });
    expect(m.integrated_lufs).toBeCloseTo(-23, 0);
  });

  it("reports silence as null instead of a number", async () => {
    const m = await measureLoudness([new Float32Array(48000 * 2), new Float32Array(48000 * 2)], 48000);
    expect(m.integrated_lufs).toBeNull();
    expect(m.true_peak_dbtp).toBeNull();
    expect(m.loudest_window).toBeNull();
    expect(assessLoudness(m, STANDARDS.ebu_r128)).toMatchObject({ measurable: false, passes: false });
  });

  it("copes with empty and very short input", async () => {
    expect((await measureLoudness([new Float32Array(0)], 48000)).integrated_lufs).toBeNull();
    expect((await measureLoudness([new Float32Array(100)], 48000)).integrated_lufs).toBeNull();
  });

  it("leaves the LFE of 5.1 out", async () => {
    const six = tone(997, -23, 5, 48000, 6);
    six[3] = tone(997, -3, 5, 48000, 1)[0];
    const quiet = tone(997, -23, 5, 48000, 6);
    const a = await measureLoudness(six, 48000);
    const b = await measureLoudness(quiet, 48000);
    expect(a.integrated_lufs).toBe(b.integrated_lufs);
  });
});

describe("true peak", () => {
  it("finds the inter-sample peak of a fs/4 sine at 45 degrees (-6.0 dBTP from samples at -9.0)", async () => {
    const n = 4800;
    const x = new Float32Array(n);
    // Tapered ends: a sine cut off abruptly really does ring at the cut, which is not what this case measures.
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.min(1, i / 200, (n - 1 - i) / 200) * Math.sin((Math.PI * i) / 2 + Math.PI / 4);
    const p = await channelPeak(x, makePolyphase(4));
    expect(20 * Math.log10(p.sample)).toBeCloseTo(-9.03, 1);
    expect(20 * Math.log10(p.true)).toBeGreaterThan(-6.15);
    expect(20 * Math.log10(p.true)).toBeLessThan(-5.95);
  });

  it("takes the skipped-chunk shortcut without missing the peak", async () => {
    // A loud burst at the start, a quiet tail: the tail's chunks are skipped, the burst's peak is kept.
    const n = 20000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i < 2000 ? 0.5 : 0.05) * Math.sin((Math.PI * i) / 2 + Math.PI / 4);
    const full = await channelPeak(x, makePolyphase(4));
    const burst = await channelPeak(x.subarray(0, 2000), makePolyphase(4));
    expect(full.true).toBeCloseTo(burst.true, 6);
  });

  it("measures per channel and reports the largest", async () => {
    const left = tone(997, -20, 2, 48000, 1)[0];
    const right = tone(997, -6, 2, 48000, 1)[0];
    const m = await measureLoudness([left, right], 48000);
    expect(m.true_peak_per_channel_dbtp[0]!).toBeCloseTo(-20, 0);
    expect(m.true_peak_per_channel_dbtp[1]!).toBeCloseTo(-6, 0);
    expect(m.true_peak_dbtp).toBe(m.true_peak_per_channel_dbtp[1]);
  });

  it("flags a clipped render: runs of full-scale samples", async () => {
    const x = new Float32Array(1000);
    x.fill(0.1);
    for (let i = 100; i < 110; i++) x[i] = 1;
    x[500] = 1; // one full-scale sample alone is not clipping
    const p = await channelPeak(x, makePolyphase(4));
    expect(p.clipped).toBe(10);
  });

  it("reads a bright sine within the 4x grid's own limit (15 to 18 kHz at 48 kHz, worst phase)", async () => {
    for (const f of [15000, 16000, 18000]) {
      let worst = Infinity;
      for (let ph = 0; ph < 16; ph++) {
        const n = 2400;
        const x = new Float32Array(n);
        for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / 48000 + (ph * Math.PI) / 16);
        const p = await channelPeak(x, makePolyphase(4));
        worst = Math.min(worst, 20 * Math.log10(p.true / 0.5));
      }
      // The best any 4x grid can do: the true crest falls between grid points, at most half a grid step away.
      const gridLimit = 20 * Math.log10(Math.cos((Math.PI * f) / (4 * 48000)));
      expect(worst).toBeGreaterThan(gridLimit - 0.12);
      expect(worst).toBeGreaterThan(-0.45);
    }
  });

  it("counts clipping for integer files only; a float file reports samples over 0 dBFS instead", async () => {
    const x = new Float32Array(1000);
    x.fill(0.1);
    for (let i = 100; i < 110; i++) x[i] = 1.2;
    const asInt = await channelPeak(x, makePolyphase(4), true);
    const asFloat = await channelPeak(x, makePolyphase(4), false);
    expect(asInt.clipped).toBe(10);
    expect(asFloat.clipped).toBe(0);
    expect(asFloat.over).toBe(10);
    const six = tone(997, -23, 5, 48000, 2);
    for (let i = 100; i < 110; i++) six[0][i] = 1.2;
    const mFloat = await measureLoudness(six, 48000, { float: true });
    expect(mFloat.clipped_samples).toBe(0);
    expect(mFloat.over_samples).toBe(10);
    expect(assessLoudness(mFloat, STANDARDS.ebu_r128).advice.join(" ")).toMatch(/over 0 dBFS/);
    expect(assessLoudness(mFloat, STANDARDS.ebu_r128).advice.join(" ")).not.toMatch(/clipped at 0 dBFS/);
    expect(isFloatFormat("wav float 32-bit")).toBe(true);
    expect(isFloatFormat("aifc fl32 32-bit")).toBe(true);
    expect(isFloatFormat("wav pcm 16-bit")).toBe(false);
  });

  it("uses 2x at 96 kHz and none at 192 kHz", () => {
    expect(makePolyphase(2).phases.length).toBe(2);
    expect(makePolyphase(1).phases.length).toBe(1);
    // Phase 0 reproduces the samples: a single centre tap of 1.
    expect(Array.from(makePolyphase(4).phases[0]).filter((v) => Math.abs(v) > 1e-9)).toEqual([1]);
  });
});

describe("gating and percentiles", () => {
  const power = (lufs: number) => 10 ** ((lufs + 0.691) / 10);

  it("applies the absolute and relative gates", () => {
    const r = gatedLoudness([power(-20), power(-20), power(-45), power(-80)]);
    expect(r.aboveAbsolute).toBe(3);
    expect(r.gated).toBe(2);
    expect(r.lufs).toBeCloseTo(-20, 5);
    expect(gatedLoudness([power(-80)]).lufs).toBeNull();
  });

  it("interpolates quantiles", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 6);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it("takes the range from the 20 LU gate, not the 10 LU one", () => {
    // 100 windows at -20 and 100 at -35: the power mean is about -23, the gate -43, so both count.
    const wins = [...Array(100).fill(power(-20)), ...Array(100).fill(power(-35))];
    expect(loudnessRange(wins)).toBeCloseTo(15, 5);
    expect(loudnessRange([power(-90)])).toBeNull();
  });
});

describe("decodeAudioChannels", () => {
  it("keeps the channels apart, and decodeAudio still returns the mono mix", () => {
    const left = Float32Array.from([0.5, -0.5, 0.25, 0]);
    const right = Float32Array.from([0, 0.5, -0.25, 0.5]);
    const buf = wav16([left, right], 44100);
    const per = decodeAudioChannels(buf);
    expect(per.channels).toBe(2);
    expect(per.frames).toBe(4);
    expect(per.channelData).toHaveLength(2);
    expect(per.channelData[0][0]).toBeCloseTo(0.5, 3);
    expect(per.channelData[1][3]).toBeCloseTo(0.5, 3);
    const mix = decodeAudio(buf);
    expect(mix.channelData).toBeUndefined();
    expect(mix.mono[0]).toBeCloseTo(0.25, 3);
    expect(mix.mono[2]).toBeCloseTo(0, 3);
  });

  it("refuses audio whose decoded samples would be over maxDecodedBytes, before decoding", () => {
    const buf = wav16(tone(440, -20, 2, 8000), 8000);
    // 2 channels x 16000 frames x 4 bytes = 128000 bytes.
    expect(() => decodeAudioChannels(buf, { maxDecodedBytes: 100000 })).toThrow(/decoded/);
    expect(decodeAudioChannels(buf, { maxDecodedBytes: 128000 }).frames).toBe(16000);
  });

  it("keeps the length limit", () => {
    const buf = wav16(tone(440, -20, 2, 8000), 8000);
    expect(() => decodeAudioChannels(buf, { maxSeconds: 1 })).toThrow(/at most/);
  });
});

// ---------- standards ----------

const measurement = (extra: Partial<LoudnessMeasurement> = {}): LoudnessMeasurement => ({
  duration: 60,
  sample_rate: 48000,
  channels: 2,
  integrated_lufs: -23,
  loudness_range_lu: 6,
  momentary_max_lufs: -18,
  short_term_max_lufs: -20,
  loudest_window: null,
  quietest_window: null,
  true_peak_dbtp: -3,
  sample_peak_dbfs: -3.5,
  true_peak_per_channel_dbtp: [-3, -3.2],
  oversampling: 4,
  blocks: { total: 100, above_absolute_gate: 100, gated: 100 },
  clipped_samples: 0,
  ...extra,
});

describe("standards and verdict", () => {
  it("resolves the named standards and lays given numbers over them", () => {
    expect(resolveStandard({})).toMatchObject({ target_lufs: -23, true_peak_max_db: -1, tolerance_lu: 0.5 });
    expect(resolveStandard({ standard: "atsc_a85" })).toMatchObject({ target_lufs: -24, true_peak_max_db: -2, tolerance_lu: 2 });
    expect(resolveStandard({ standard: "streaming", true_peak_max_db: -2 })).toMatchObject({ target_lufs: -14, true_peak_max_db: -2 });
    expect(resolveStandard({ standard: "custom", target_lufs: -16 })).toMatchObject({ name: "Custom", target_lufs: -16, true_peak_max_db: -1, tolerance_lu: 1 });
  });

  it("passes a mix inside the tolerance with the peak under the ceiling", () => {
    const v = assessLoudness(measurement({ integrated_lufs: -23.3 }), STANDARDS.ebu_r128);
    expect(v).toMatchObject({ passes: true, loudness_ok: true, true_peak_ok: true, peak_conflict: false });
    expect(v.advice[0]).toMatch(/Meets EBU R128/);
  });

  it("asks for the gain that lands on the target", () => {
    const v = assessLoudness(measurement({ integrated_lufs: -27.4, true_peak_dbtp: -10 }), STANDARDS.ebu_r128);
    expect(v).toMatchObject({ passes: false, loudness_ok: false, gain_needed_db: 4.4, true_peak_after_gain_dbtp: -5.6, peak_conflict: false });
  });

  it("reports a loudness against true-peak conflict instead of a clipping gain", () => {
    const v = assessLoudness(measurement({ integrated_lufs: -20, true_peak_dbtp: -2 }), STANDARDS.streaming);
    expect(v).toMatchObject({ gain_needed_db: 6, true_peak_after_gain_dbtp: 4, peak_conflict: true, max_gain_within_peak_db: 1, lufs_at_peak_limit: -19 });
    expect(v.advice.join(" ")).toMatch(/no limiter/);
  });

  it("says a too-loud mix needs a negative gain, with no conflict", () => {
    const v = assessLoudness(measurement({ integrated_lufs: -16, true_peak_dbtp: -0.2 }), STANDARDS.ebu_r128);
    expect(v).toMatchObject({ gain_needed_db: -7, peak_conflict: false, true_peak_ok: false });
  });

  it("warns that a clipped render describes the clipped file", () => {
    const v = assessLoudness(measurement({ clipped_samples: 30 }), STANDARDS.ebu_r128);
    expect(v.advice.join(" ")).toMatch(/clipped at 0 dBFS/);
  });
});

// ---------- schemas ----------

describe("schemas", () => {
  it("ae_loudness_check wants one source, expect with a comp, and a target for custom", () => {
    expect(AeLoudnessCheckSchema.safeParse({}).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ comp_id: 1 }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(true);
    expect(AeLoudnessCheckSchema.safeParse({ comp_id: 1, job_id: "x", expect: expectArg }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ audio_path: "/a.wav", standard: "custom" }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ audio_path: "/a.wav", standard: "custom", target_lufs: -16 }).success).toBe(true);
    expect(AeLoudnessCheckSchema.safeParse({ audio_path: "/a.wav", standard: "dolby" }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ comp_id: 1, start: 5, end: 2, expect: expectArg }).success).toBe(false);
  });

  it("ae_loudness_check refuses range and template arguments that its source would ignore", () => {
    expect(AeLoudnessCheckSchema.safeParse({ audio_path: "/a.wav", start: 1 }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ audio_path: "/a.wav", end: 3 }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ job_id: "j", output_module_template: "X" }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ comp_id: 1, expect: expectArg, time_offset: 2 }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ job_id: "j", time_offset: 2 }).success).toBe(false);
    expect(AeLoudnessCheckSchema.safeParse({ audio_path: "/a.wav", time_offset: 2 }).success).toBe(true);
    expect(AeLoudnessCheckSchema.safeParse({ comp_id: 1, expect: expectArg, start: 1, end: 3, output_module_template: "X" }).success).toBe(true);
  });

  it("ae_loudness_apply wants a gain or a fade, and the two peak numbers together", () => {
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, gain_db: 0, expect: expectArg }).success).toBe(false);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, gain_db: 3, expect: expectArg }).success).toBe(true);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, fade_out: 1.5, expect: expectArg }).success).toBe(true);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, gain_db: 3, true_peak_db: -3, expect: expectArg }).success).toBe(false);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, gain_db: 3, true_peak_db: -3, true_peak_max_db: -1, expect: expectArg }).success).toBe(true);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, gain_db: 3 }).success).toBe(false);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, gain_db: 300, expect: expectArg }).success).toBe(false);
  });

  it("the mutating tool ends its description with the agent safety guidance", () => {
    expect(tool("ae_loudness_apply").description).toMatch(/Jay may be editing live/);
    expect(loudnessTools.map((t) => t.name)).toEqual(["ae_loudness_check", "ae_loudness_apply"]);
  });
});

// ---------- ae_loudness_check ----------

describe("applyHint", () => {
  const m = (lufs: number, tp: number) => ({ integrated_lufs: lufs, true_peak_dbtp: tp, clipped_samples: 0, over_samples: 0 }) as unknown as LoudnessMeasurement;
  const std = STANDARDS.ebu_r128;

  it("hands over the full gain when the peak allows it", () => {
    const meas = m(-26, -12);
    expect(applyHint(meas, std, assessLoudness(meas, std))?.gain_db).toBe(3);
  });

  it("with a peak conflict hands over the gain the ceiling allows, which the apply tool accepts", () => {
    const meas = m(-30, -4);
    const v = assessLoudness(meas, std);
    expect(v.peak_conflict).toBe(true);
    const h = applyHint(meas, std, v)!;
    expect(h.gain_db).toBe(3);
    expect(h.reaches_lufs).toBe(-27);
    expect(h.true_peak_db! + h.gain_db).toBeLessThanOrEqual(h.true_peak_max_db + 1e-9);
    expect(h.note).toMatch(/most the ceiling allows/);
  });

  it("with a peak over the ceiling offers the negative gain, even when the loudness is low", () => {
    const meas = m(-26, 1);
    const h = applyHint(meas, std, assessLoudness(meas, std))!;
    expect(h.gain_db).toBe(-2);
    expect(h.note).toMatch(/negative gain/);
  });

  it("keeps the larger cut when the loudness is also too high", () => {
    const meas = m(-14, -0.5);
    expect(applyHint(meas, std, assessLoudness(meas, std))?.gain_db).toBe(-9);
  });

  it("offers nothing for a mix that already passes, and never a gain the apply tool would refuse", () => {
    const meas = m(-23.4, -1.2);
    const v = assessLoudness(meas, std);
    expect(v.passes).toBe(true);
    expect(applyHint(meas, std, v)).toBeNull();
    // Loudness out of tolerance: whatever is offered stays under the ceiling.
    const quiet = m(-30, -2.5);
    const h = applyHint(quiet, std, assessLoudness(quiet, std));
    if (h) expect(h.true_peak_db! + h.gain_db).toBeLessThanOrEqual(h.true_peak_max_db + 1e-9);
  });

  it("keeps the gain inside what ae_loudness_apply accepts", () => {
    const meas = m(-69, -80);
    const h = applyHint(meas, STANDARDS.streaming, assessLoudness(meas, STANDARDS.streaming))!;
    expect(h.gain_db).toBeLessThanOrEqual(48);
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, expect: expectArg, gain_db: h.gain_db, true_peak_db: h.true_peak_db, true_peak_max_db: h.true_peak_max_db }).success).toBe(true);
  });

  it("offers nothing when no gain of 0.05 dB or more is right", () => {
    const meas = m(-23, -5);
    expect(applyHint(meas, std, assessLoudness(meas, std))).toBeNull();
  });
});

describe("ae_loudness_check", () => {
  it("measures a file by path without touching AE", async () => {
    const file = path.join(tempDir("chroma-loud-path-"), "mix.wav");
    fs.writeFileSync(file, wav16(tone(997, -23, 6), 48000));
    const { ctx, calls } = fakeAe({});
    const out = await tool("ae_loudness_check").handler(AeLoudnessCheckSchema.parse({ audio_path: file, time_offset: 2 }), ctx);
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ ok: true, state: "done", time_offset: 2, clipped_in_render: false });
    expect(out.measurement.integrated_lufs).toBeCloseTo(-23, 0);
    expect(out.verdict).toMatchObject({ passes: true });
    expect(out.loudest_window.start).toBeGreaterThanOrEqual(2);
    expect(out.apply_hint).toBeUndefined();
  });

  it("returns a ready gain for ae_loudness_apply when the mix is off target", async () => {
    const file = path.join(tempDir("chroma-loud-gain-"), "quiet.wav");
    fs.writeFileSync(file, wav16(tone(997, -30, 6), 48000));
    const { ctx } = fakeAe({});
    const out = await tool("ae_loudness_check").handler(AeLoudnessCheckSchema.parse({ audio_path: file, standard: "streaming" }), ctx);
    expect(out.verdict.passes).toBe(false);
    expect(out.verdict.gain_needed_db).toBeCloseTo(16, 0);
    expect(out.apply_hint.gain_db).toBeCloseTo(16, 0);
    expect(out.apply_hint.true_peak_max_db).toBe(-1);
    // The hint is valid input for ae_loudness_apply.
    expect(AeLoudnessApplySchema.safeParse({ comp_id: 1, expect: expectArg, ...out.apply_hint, note: undefined }).success).toBe(true);
  });

  it("tells an audio_path file that is too long to trim the file, not to use start/end", async () => {
    const { ctx } = fakeAe({});
    const long = path.join(tempDir("chroma-loud-long-"), "long.wav");
    fs.writeFileSync(long, wav16([new Float32Array(8000 * 1250)], 8000));
    const out = (await tool("ae_loudness_check").handler(AeLoudnessCheckSchema.parse({ audio_path: long }), ctx)) as { ok: boolean; error?: string; message?: string };
    expect(out).toMatchObject({ ok: false, error: "bad_audio" });
    expect(out.message).toMatch(/trim the file/);
    expect(out.message).not.toContain("(use start/end)");
  });

  it("rejects a missing path and a bad file", async () => {
    const { ctx } = fakeAe({});
    const run = (p: string) => tool("ae_loudness_check").handler(AeLoudnessCheckSchema.parse({ audio_path: p }), ctx);
    expect(await run("relative.wav")).toMatchObject({ ok: false, error: "bad_path" });
    const junk = path.join(tempDir("chroma-loud-junk-"), "junk.wav");
    fs.writeFileSync(junk, Buffer.alloc(64));
    expect(await run(junk)).toMatchObject({ ok: false, error: "bad_audio" });
  });

  it("starts an aerender job for the comp's audio, waits, and measures the file it wrote", async () => {
    const dir = tempDir("chroma-loud-render-");
    const started: Array<Record<string, unknown>> = [];
    let state: "running" | "succeeded" = "running";
    let output = "";
    const tools = createLoudnessTools({
      rendersDir: () => dir,
      pollMs: 5,
      startRender: async (args) => {
        started.push(args);
        output = String(args.output_path);
        setTimeout(() => {
          fs.writeFileSync(output, wav16(tone(997, -23, 4), 48000));
          state = "succeeded";
        }, 20);
        return { ok: true, job_id: "job_1" };
      },
      getJob: () => ({ state, output_path: output, log_path: "x.log" }),
    });
    const { ctx, calls } = fakeAe({ loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])] });
    const args = AeLoudnessCheckSchema.parse({ comp_id: 1, start: 1, end: 3, expect: { project_path: "C:/p/x.aep" } });
    const out = await tool("ae_loudness_check", tools).handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["loudnessRead"]);
    expect(started[0]).toMatchObject({ comp_name: "Edit", output_module_template: "AIFF 48kHz", start_frame: 25, end_frame: 74 });
    expect(out).toMatchObject({ ok: true, state: "done", job_id: "job_1", comp_id: 1, time_offset: 1 });
    expect(out.measurement.integrated_lufs).toBeCloseTo(-23, 0);
    expect(fs.existsSync(`${output}.json`)).toBe(true);
    // The same job collected again by id, from the in-memory record.
    const again = await tool("ae_loudness_check", tools).handler(AeLoudnessCheckSchema.parse({ job_id: "job_1" }), ctx);
    expect(again).toMatchObject({ ok: true, state: "done", time_offset: 1 });
    // And by a fresh instance (a restart): the sidecar next to the render carries the offset.
    const fresh = createLoudnessTools({ rendersDir: () => dir, pollMs: 5, getJob: () => ({ state: "succeeded", output_path: output, log_path: "x.log" }) });
    const restarted = await tool("ae_loudness_check", fresh).handler(AeLoudnessCheckSchema.parse({ job_id: "job_1" }), ctx);
    expect(restarted).toMatchObject({ ok: true, state: "done", time_offset: 1, comp_id: 1 });
    // A job ae_audio_analyze started: its sidecar has the same shape.
    const other = path.join(dir, "analyze_x.aif");
    fs.writeFileSync(other, wav16(tone(997, -23, 2), 48000));
    fs.writeFileSync(`${other}.json`, JSON.stringify({ comp_id: 7, comp_name: "Other", offset: 2.5, fps: 24, output_path: other }));
    const cross = createLoudnessTools({ rendersDir: () => dir, pollMs: 5, getJob: () => ({ state: "succeeded", output_path: other, log_path: "x.log" }) });
    expect(await tool("ae_loudness_check", cross).handler(AeLoudnessCheckSchema.parse({ job_id: "job_9" }), ctx)).toMatchObject({ ok: true, comp_id: 7, time_offset: 2.5 });
    // Without a sidecar the job is unknown.
    fs.rmSync(`${other}.json`);
    expect(await tool("ae_loudness_check", cross).handler(AeLoudnessCheckSchema.parse({ job_id: "job_9" }), ctx)).toMatchObject({ ok: false, error: "unknown_job" });
  });

  it("gives every render its own file, so two checks in the same second do not share one", async () => {
    const dir = tempDir("chroma-loud-unique-");
    const outputs: string[] = [];
    const tools = createLoudnessTools({
      rendersDir: () => dir,
      pollMs: 5,
      startRender: async (args) => {
        outputs.push(String(args.output_path));
        return { ok: true, job_id: `j${outputs.length}` };
      },
      getJob: () => ({ state: "running", output_path: "x.aif", log_path: "x.log" }),
    });
    const { ctx } = fakeAe({ loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))]), compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])] });
    const args = AeLoudnessCheckSchema.parse({ comp_id: 1, wait_seconds: 0, expect: expectArg });
    await tool("ae_loudness_check", tools).handler(args, ctx);
    await tool("ae_loudness_check", tools).handler(args, ctx);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).not.toBe(outputs[1]);
    expect(outputs[0]).toMatch(/loudness_Edit_\d{8}T\d{6}_[0-9a-f]{6}\.aif$/);
  });

  it("deletes loudness renders older than a day when it starts a new one, and nothing else", async () => {
    const dir = tempDir("chroma-loud-prune-");
    const audio = path.join(dir, "audio");
    fs.mkdirSync(audio, { recursive: true });
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    for (const n of ["loudness_Edit_old.aif", "loudness_Edit_old.aif.json", "loudness_Edit_old.wav", "loudness_Edit_old.aiff", "analyze_old.aif", "notes.txt"]) {
      fs.writeFileSync(path.join(audio, n), "x");
      fs.utimesSync(path.join(audio, n), old, old);
    }
    fs.writeFileSync(path.join(audio, "loudness_Edit_new.aif"), "x");
    const tools = createLoudnessTools({ rendersDir: () => dir, startRender: async () => ({ ok: true, job_id: "p1" }), getJob: () => ({ state: "running", output_path: "x.aif", log_path: "x.log" }) });
    const { ctx } = fakeAe({ loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])] });
    await tool("ae_loudness_check", tools).handler(AeLoudnessCheckSchema.parse({ comp_id: 1, wait_seconds: 0, expect: expectArg }), ctx);
    expect(fs.existsSync(path.join(audio, "loudness_Edit_old.aif"))).toBe(false);
    expect(fs.existsSync(path.join(audio, "loudness_Edit_old.aif.json"))).toBe(false);
    expect(fs.existsSync(path.join(audio, "loudness_Edit_old.wav"))).toBe(false);
    expect(fs.existsSync(path.join(audio, "loudness_Edit_old.aiff"))).toBe(false);
    expect(fs.existsSync(path.join(audio, "analyze_old.aif"))).toBe(true);
    expect(fs.existsSync(path.join(audio, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(audio, "loudness_Edit_new.aif"))).toBe(true);
    expect(pruneOldRenders(path.join(dir, "missing"))).toBe(0);
  });

  it("bounds file plus decoded samples together, not each alone", () => {
    const MB = 1024 * 1024;
    expect(decodedBudget(440 * MB)).toBe(584 * MB);
    expect(decodedBudget(100 * MB)).toBe(600 * MB);
    expect(decodedBudget(600 * MB)).toBe(424 * MB);
    expect(decodedBudget(2000 * MB)).toBe(0);
  });

  it("reads the comp without level keys and waits as long as a slow host needs", async () => {
    const tools = createLoudnessTools({ rendersDir: () => tempDir("chroma-loud-slow-"), startRender: async () => ({ job_id: "s1" }), getJob: () => ({ state: "running", output_path: "x.aif", log_path: "x.log" }) });
    const { ctx, host } = fakeAe({ loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])] });
    const spy = vi.spyOn(host, "callHost");
    await tool("ae_loudness_check", tools).handler(AeLoudnessCheckSchema.parse({ comp_id: 1, wait_seconds: 0, expect: expectArg }), ctx);
    const read = spy.mock.calls.find((c) => c[0] === "loudnessRead")!;
    expect(read[1]).toMatchObject({ skip_keys: true });
    expect((read[2] as { timeoutMs?: number }).timeoutMs).toBe(600_000);
  });

  it("returns the job id when the render outlasts wait_seconds, and reports a failed render", async () => {
    const running = createLoudnessTools({
      rendersDir: () => tempDir("chroma-loud-wait-"),
      pollMs: 5,
      startRender: async () => ({ ok: true, job_id: "job_2" }),
      getJob: () => ({ state: "running", output_path: "nowhere.aif", log_path: "x.log" }),
    });
    const { ctx } = fakeAe({ loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])] });
    const wait = await running[0].handler(AeLoudnessCheckSchema.parse({ comp_id: 1, wait_seconds: 0, expect: expectArg }), ctx);
    expect(wait).toMatchObject({ ok: true, state: "rendering", job_id: "job_2" });

    const failing = createLoudnessTools({
      rendersDir: () => tempDir("chroma-loud-fail-"),
      pollMs: 5,
      startRender: async () => ({ ok: true, job_id: "job_3" }),
      getJob: () => ({ state: "failed", output_path: "nowhere.aif", log_path: "x.log", error: "boom" }),
    });
    const { ctx: ctx2 } = fakeAe({ loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])] });
    const out = await failing[0].handler(AeLoudnessCheckSchema.parse({ comp_id: 1, expect: expectArg }), ctx2);
    expect(out).toMatchObject({ ok: false, error: "render_failed" });
  });

  it("refuses a comp whose name is shared, that has no sound, or a range with nothing in it", async () => {
    const tools = createLoudnessTools({ startRender: async () => ({ job_id: "never" }) });
    const run = async (info: object, extra: object = {}) => {
      const { ctx } = fakeAe({ loudnessRead: [info] });
      return tools[0].handler(AeLoudnessCheckSchema.parse({ comp_id: 1, expect: { project_path: "C:/p/x.aep" }, ...extra }), ctx);
    };
    const layers = [soundLayer(1, 10, "Music", lv([0, 0]))];
    expect(await run(compInfo(layers, { name_unique: false }))).toMatchObject({ ok: false, error: "ambiguous_comp" });
    expect(await run(compInfo([soundLayer(1, 10, "Muted", lv([0, 0]), { audio_enabled: false })]))).toMatchObject({ ok: false, error: "no_audio" });
    expect(await run(compInfo(layers), { start: 10 })).toMatchObject({ ok: false, error: "bad_range" });
    expect(await run(compInfo(layers, { duration: 3600 }))).toMatchObject({ ok: false, error: "too_long" });
  });
});

// ---------- ae_loudness_apply ----------

describe("ae_loudness_apply", () => {
  it("guards, reads, writes, and reads back in a separate call", async () => {
    const before = compInfo([soundLayer(1, 10, "Music", lv([0, 0])), soundLayer(2, 11, "VO", lv([-6, -6]))]);
    const after = compInfo([soundLayer(1, 10, "Music", lv([4, 4])), soundLayer(2, 11, "VO", lv([-2, -2]))]);
    const { ctx, calls } = fakeAe({
      loudnessRead: [before, after],
      loudnessApply: [
        {
          gain_db: 4,
          fade_in: 0,
          fade_out: 0,
          fade_floor_db: -96,
          layers: [
            { index: 1, id: 10, name: "Music", mode: "static", value: [4, 4], keys: [], clamped: false },
            { index: 2, id: 11, name: "VO", mode: "static", value: [-2, -2], keys: [], clamped: false },
          ],
        },
      ],
    });
    const args = AeLoudnessApplySchema.parse({ comp_id: 1, gain_db: 4, expect: expectArg });
    const out = await tool("ae_loudness_apply").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "loudnessRead", "loudnessApply", "loudnessRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(out).toMatchObject({ applied: true, gain_db: 4 });
    expect(out.receipt.matches).toBe(true);
    expect(out.layers).toHaveLength(2);
    expect(out.next_step).toMatch(/ae_save/);
  });

  it("refuses a gain over the true-peak ceiling before touching AE, and allows it on request", async () => {
    const { ctx, calls } = fakeAe({});
    const args = AeLoudnessApplySchema.parse({ comp_id: 1, gain_db: 6, true_peak_db: -4, true_peak_max_db: -1, expect: expectArg });
    const out = await tool("ae_loudness_apply").handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "true_peak_conflict", max_gain_db: 3 });
    expect(calls).toEqual([]);

    const ok = fakeAe({
      loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))]), compInfo([soundLayer(1, 10, "Music", lv([6, 6]))])],
      loudnessApply: [{ gain_db: 6, layers: [{ index: 1, id: 10, name: "Music", mode: "static", value: [6, 6], keys: [], clamped: false }] }],
    });
    const forced = await tool("ae_loudness_apply").handler({ ...args, allow_over_peak: true }, ok.ctx);
    expect(forced).toMatchObject({ applied: true });
  });

  it("gives the read, the write and the read-back the slow timeout", async () => {
    const { ctx, host } = fakeAe({
      loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))]), compInfo([soundLayer(1, 10, "Music", lv([3, 3]))])],
      loudnessApply: [{ gain_db: 3, layers: [{ index: 1, id: 10, name: "Music", mode: "static", value: [3, 3], keys: [], clamped: false }] }],
    });
    const spy = vi.spyOn(host, "evalRaw");
    await tool("ae_loudness_apply").handler(AeLoudnessApplySchema.parse({ comp_id: 1, gain_db: 3, expect: expectArg }), ctx);
    const timeouts = spy.mock.calls
      .map((c) => [/__chromaAe\.(\w+)\(/.exec(c[0].script)?.[1], c[0].timeoutMs])
      .filter((c) => c[0] === "loudnessRead" || c[0] === "loudnessApply");
    expect(timeouts).toEqual([
      ["loudnessRead", 600_000],
      ["loudnessApply", 600_000],
      ["loudnessRead", 600_000],
    ]);
  });

  it("lets a negative gain through whatever the peak", async () => {
    const { ctx } = fakeAe({
      loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))]), compInfo([soundLayer(1, 10, "Music", lv([-6, -6]))])],
      loudnessApply: [{ gain_db: -6, layers: [{ index: 1, id: 10, name: "Music", mode: "static", value: [-6, -6], keys: [], clamped: false }] }],
    });
    const args = AeLoudnessApplySchema.parse({ comp_id: 1, gain_db: -6, true_peak_db: 0, true_peak_max_db: -1, expect: expectArg });
    expect(await tool("ae_loudness_apply").handler(args, ctx)).toMatchObject({ applied: true });
  });

  it("puts a failed read-back into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])],
      loudnessApply: [{ gain_db: 3, layers: [{ index: 1, id: 10, name: "Music", mode: "static", value: [3, 3], keys: [], clamped: false }] }],
    });
    const out = await tool("ae_loudness_apply").handler(AeLoudnessApplySchema.parse({ comp_id: 1, gain_db: 3, expect: expectArg }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt)).toMatch(/Do not resend/);
  });

  it("flags a level the read-back does not show", async () => {
    const { ctx } = fakeAe({
      loudnessRead: [compInfo([soundLayer(1, 10, "Music", lv([0, 0]))]), compInfo([soundLayer(1, 10, "Music", lv([0, 0]))])],
      loudnessApply: [{ gain_db: 3, layers: [{ index: 1, id: 10, name: "Music", mode: "static", value: [3, 3], keys: [], clamped: false }] }],
    });
    const out = await tool("ae_loudness_apply").handler(AeLoudnessApplySchema.parse({ comp_id: 1, gain_db: 3, expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
  });
});

describe("levelsMismatches", () => {
  const written = (extra: object) => ({
    layers: [{ index: 1, id: 10, name: "Music", mode: "keys", value: null, keys: [{ time: 0, value: [-96, -96] }, { time: 1, value: [3, 3] }], clamped: false, ...extra }],
  });
  const keyed = (keys: Array<{ time: number; value: number[] }>, extra: object = {}) =>
    compInfo([soundLayer(1, 10, "Music", lv(null, { num_keys: keys.length, keys, ...extra }))]);

  it("accepts keys that match, within a frame of time", () => {
    const after = keyed([{ time: 0, value: [-96, -96] }, { time: 1.01, value: [3.005, 3] }]);
    expect(levelsMismatches(null, after, written({}))).toEqual([]);
  });

  it("flags a missing key, a wrong value and a wrong count", () => {
    const after = keyed([{ time: 0, value: [-90, -96] }]);
    const paths = levelsMismatches(null, after, written({})).map((m) => m.path);
    expect(paths).toContain("layers[Music].levels.num_keys");
    expect(paths).toContain("layers[Music].levels@0");
    expect(paths).toContain("layers[Music].levels@1");
  });

  it("checks the keys it holds when the read-back is capped, and does not flag the rest", () => {
    const w = written({ key_count: 300 });
    const after = keyed([{ time: 0, value: [-96, -96] }], { num_keys: 300, keys_truncated: true });
    expect(levelsMismatches(null, after, w)).toEqual([]);
  });

  it("still checks the key count when the read-back is capped", () => {
    const after = keyed([{ time: 0, value: [-96, -96] }], { num_keys: 7, keys_truncated: true });
    expect(levelsMismatches(null, after, written({ key_count: 300 })).map((m) => m.path)).toContain("layers[Music].levels.num_keys");
  });

  it("matches each key to the nearest read-back key, so keys closer than half a frame do not clash", () => {
    const w = { layers: [{ index: 1, id: 10, name: "Music", mode: "keys", value: null, keys: [{ time: 1, value: [-96, -96] }, { time: 1.01, value: [0, 0] }], clamped: false }] };
    const right = keyed([{ time: 1, value: [-96, -96] }, { time: 1.01, value: [0, 0] }]);
    expect(levelsMismatches(null, right, w)).toEqual([]);
    const wrong = keyed([{ time: 1, value: [-96, -96] }, { time: 1.01, value: [-50, -50] }]);
    expect(levelsMismatches(null, wrong, w).map((m) => m.path)).toEqual(["layers[Music].levels@1.01"]);
  });

  it("flags a layer that was not a target but changed", () => {
    const before = compInfo([soundLayer(1, 10, "Music", lv([0, 0])), soundLayer(2, 11, "VO", lv([-6, -6]))]);
    const after = compInfo([soundLayer(1, 10, "Music", lv([3, 3])), soundLayer(2, 11, "VO", lv([-3, -3]))]);
    const w = { layers: [{ index: 1, id: 10, name: "Music", mode: "static", value: [3, 3], keys: [], clamped: false }] };
    expect(levelsMismatches(before, after, w).map((m) => m.path)).toEqual(["layers[VO].levels"]);
    expect(levelsMismatches(before, compInfo([soundLayer(1, 10, "Music", lv([3, 3])), soundLayer(2, 11, "VO", lv([-6, -6]))]), w)).toEqual([]);
  });

  it("flags a layer missing from the read-back unless the list was capped", () => {
    const w = written({});
    expect(levelsMismatches(null, compInfo([]), w)).toHaveLength(1);
    expect(levelsMismatches(null, compInfo([], { truncated: true }), w)).toEqual([]);
  });
});

// ---------- the host functions, under node:vm ----------

interface SceneLayer {
  layer: FakeLayer;
  levels: FakeProperty;
}

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Mix", 640, 360, 10);
  const add = (name: string, value: number[], extra: Record<string, unknown> = {}): SceneLayer => {
    const layer = comp.layers.addSolid([0, 0, 0], name, 100, 100, 1, 10);
    const levels = new FakeProperty("Audio Levels", "ADBE Audio Levels", PropertyValueType.TwoD, value);
    Object.assign(levels, { hasMin: true, minValue: -192, hasMax: true, maxValue: 24 }, extra);
    layer.group.props.push(new FakeGroup("Audio", "ADBE Audio Group", [levels]));
    layer.hasAudio = true;
    return { layer, levels };
  };
  const music = add("Music", [0, 0]);
  const vo = add("VO", [-6, -6]);
  const host = loadHost(project, ["loudness.jsx"]);
  return { project, comp: comp as FakeComp, music, vo, add, ...host };
}

/** What the server would see: the vm's plain objects as JSON. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("loudness.jsx", () => {
  it("reads the comp and its sound layers without opening an undo group", () => {
    const { A, comp, undo, music } = scene();
    const silent = comp.layers.addNull(10);
    void silent;
    music.levels.setValueAtTime(0, [0, 0]);
    music.levels.setValueAtTime(2, [-3, -3]);
    const r = wire(A.loudnessRead({ comp_id: comp.id }));
    expect(r).toMatchObject({ name: "Mix", name_unique: true, duration: 10, fps: 25, truncated: false });
    expect(r.layers.map((l: { name: string }) => l.name)).toEqual(["VO", "Music"]);
    const m = r.layers.find((l: { name: string }) => l.name === "Music");
    expect(m.levels).toMatchObject({ num_keys: 2, min: -192, max: 24, expression: false });
    expect(m.levels.keys).toEqual([{ time: 0, value: [0, 0] }, { time: 2, value: [-3, -3] }]);
    expect(r.layers.find((l: { name: string }) => l.name === "VO").levels.value).toEqual([-6, -6]);
    expect(undo.begun).toBe(0);
  });

  it("adds a gain to a plain level in one undo group", () => {
    const { A, comp, undo, music, vo } = scene();
    const out = wire(A.loudnessApply({ comp_id: comp.id, gain_db: 3.5, expect: GUARD }));
    expect(music.levels.value).toEqual([3.5, 3.5]);
    expect(vo.levels.value).toEqual([-2.5, -2.5]);
    expect(out.layers.map((l: { mode: string }) => l.mode)).toEqual(["static", "static"]);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("offsets every key of a keyed level instead of calling setValue", () => {
    const { A, comp, music } = scene();
    music.levels.setValueAtTime(0, [-10, -10]);
    music.levels.setValueAtTime(2, [0, -4]);
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], gain_db: 2, expect: GUARD });
    expect(music.levels.keys.map((k) => k.value)).toEqual([[-8, -8], [2, -2]]);
    expect(music.levels.keys.map((k) => k.time)).toEqual([0, 2]);
  });

  it("only touches the layers named, once each", () => {
    const { A, comp, music, vo } = scene();
    const out = wire(A.loudnessApply({ comp_id: comp.id, layers: [{ name: "VO" }, { index: 1 }], gain_db: 1, expect: GUARD }));
    expect(out.layers).toHaveLength(1);
    expect(vo.levels.value).toEqual([-5, -5]);
    expect(music.levels.value).toEqual([0, 0]);
  });

  it("skips layers whose audio is switched off when none are named", () => {
    const { A, comp, music, vo } = scene();
    vo.layer.audioEnabled = false;
    A.loudnessApply({ comp_id: comp.id, gain_db: 1, expect: GUARD });
    expect(music.levels.value).toEqual([1, 1]);
    expect(vo.levels.value).toEqual([-6, -6]);
  });

  it("with fade_scope layer, fades in and out with keys at the layer's ends, merged with the level", () => {
    const { A, comp, vo } = scene();
    vo.layer.inPoint = 1;
    vo.layer.outPoint = 9;
    const out = wire(A.loudnessApply({ comp_id: comp.id, layers: [{ name: "VO" }], gain_db: 2, fade_in: 0.5, fade_out: 1, fade_scope: "layer", expect: GUARD }));
    expect(vo.levels.keys.map((k) => [k.time, k.value])).toEqual([
      [1, [-96, -96]],
      [1.5, [-4, -4]],
      [8, [-4, -4]],
      [9, [-96, -96]],
    ]);
    expect(out.layers[0]).toMatchObject({ mode: "keys" });
    expect(out.layers[0].keys).toHaveLength(4);
  });

  it("merges a fade with existing keys: they are offset, and a key at the fade's start is replaced", () => {
    const { A, comp, music } = scene();
    music.levels.setValueAtTime(0, [-6, -6]);
    music.levels.setValueAtTime(4, [-12, -12]);
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], gain_db: 3, fade_in: 1, expect: GUARD });
    expect(music.levels.keys.map((k) => [k.time, k.value])).toEqual([
      [0, [-96, -96]],
      [1, [-4.5, -4.5]],
      [4, [-9, -9]],
    ]);
  });

  it("fades the mix at the comp's edges: a layer trimmed before 0 or past the end is faded at the edge", () => {
    const { A, comp, music, vo } = scene();
    music.layer.inPoint = -2;
    music.layer.outPoint = 12;
    vo.layer.inPoint = 3;
    vo.layer.outPoint = 6;
    const out = wire(A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }, { name: "VO" }], fade_in: 1, fade_out: 2, expect: GUARD }));
    expect(music.levels.keys.map((k) => [k.time, k.value])).toEqual([
      [0, [-96, -96]],
      [1, [0, 0]],
      [8, [0, 0]],
      [10, [-96, -96]],
    ]);
    // The clip in the middle of the comp is not part of the mix's edges: it keeps its level and no key.
    expect(vo.levels.keys).toHaveLength(0);
    expect(out.skipped).toEqual(["VO"]);
    expect(out.layers.map((l: { name: string }) => l.name)).toEqual(["Music"]);
  });

  it("gives a mid-comp layer the gain only, and refuses a comp-scope fade that reaches no layer", () => {
    const { A, comp, undo, music, vo } = scene();
    music.layer.inPoint = 2;
    vo.layer.inPoint = 3;
    A.loudnessApply({ comp_id: comp.id, gain_db: 1, fade_in: 1, expect: GUARD });
    expect(music.levels.value).toEqual([1, 1]);
    expect(vo.levels.value).toEqual([-5, -5]);
    expect(music.levels.keys).toHaveLength(0);
    const begun = undo.begun;
    expect(() => A.loudnessApply({ comp_id: comp.id, fade_in: 1, expect: GUARD })).toThrow(/Nothing to change/);
    expect(undo.begun).toBe(begun);
  });

  it("checks a layer-scope fade against the layer's own length", () => {
    const { A, comp, music } = scene();
    music.layer.outPoint = 1.5;
    expect(() => A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 2, fade_scope: "layer", expect: GUARD })).toThrow(/audible for 1.5 s/);
    expect(() => A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 1, fade_scope: "layer", expect: GUARD })).not.toThrow();
  });

  it("with comp scope, a layer that enters during the fade gets the part of the ramp that falls on it", () => {
    const { A, comp, music } = scene();
    music.layer.inPoint = 1;
    const out = wire(A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 4, expect: GUARD }));
    const keys = music.levels.keys.map((k) => [k.time, (k.value as number[])[0]]);
    // The mix is 25 % of the way up at 1 s (floor -96 .. 0 dB), full at 4 s.
    expect(keys.map((k) => k[0])).toEqual([1, 4]);
    expect(keys[0][1]).toBeCloseTo(-96 + 96 * 0.25, 6);
    expect(keys[1][1]).toBe(0);
    expect(out.layers[0].fade_in).toBe(4);
  });

  it("with comp scope, a layer that leaves during the fade-out is cut off partway down the ramp", () => {
    const { A, comp, music } = scene();
    music.layer.outPoint = 9;
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_out: 4, expect: GUARD });
    const keys = music.levels.keys.map((k) => [k.time, (k.value as number[])[0]]);
    expect(keys.map((k) => k[0])).toEqual([6, 9]);
    expect(keys[0][1]).toBe(0);
    expect(keys[1][1]).toBeCloseTo(-96 + 96 * 0.25, 6);
  });

  it("with comp scope, a short layer inside a long fade is not refused", () => {
    const { A, comp, music } = scene();
    music.layer.outPoint = 1;
    expect(() => A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 2, expect: GUARD })).not.toThrow();
    const keys = music.levels.keys.map((k) => [k.time, (k.value as number[])[0]]);
    expect(keys.map((k) => k[0])).toEqual([0, 1]);
    expect(keys[0][1]).toBe(-96);
    expect(keys[1][1]).toBeCloseTo(-48, 6);
  });

  it("refuses comp-scope fades longer than the comp", () => {
    const { A, comp, undo } = scene();
    expect(() => A.loudnessApply({ comp_id: comp.id, fade_in: 6, fade_out: 5, expect: GUARD })).toThrow(/add up/);
    expect(undo.begun).toBe(0);
  });

  it("never fades from a level above the layer's own: the edge keys take the lower of the floor and the level", () => {
    const { A, comp, music } = scene();
    music.levels.staticValue = [-20, -20];
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 1, fade_out: 1, fade_floor_db: -6, expect: GUARD });
    expect(music.levels.keys.map((k) => [k.time, k.value])).toEqual([
      [0, [-20, -20]],
      [1, [-20, -20]],
      [9, [-20, -20]],
      [10, [-20, -20]],
    ]);
  });

  it("blends an existing key inside a fade into the ramp, so the fade keeps its length", () => {
    const { A, comp, music } = scene();
    music.levels.setValueAtTime(0.2, [-10, -10]);
    music.levels.setValueAtTime(5, [-10, -10]);
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 1, expect: GUARD });
    const keys = music.levels.keys.map((k) => [k.time, k.value]);
    expect(keys.map((k) => k[0])).toEqual([0, 0.2, 1, 5]);
    // 20 % of the way from the floor (-96) to -10 dB.
    expect((keys[1][1] as number[])[0]).toBeCloseTo(-96 + 86 * 0.2, 6);
    expect((keys[0][1] as number[])[0]).toBe(-96);
    expect((keys[2][1] as number[])[0]).toBeCloseTo(-10, 6);
  });

  it("rejects an unknown fade_scope before changing anything", () => {
    const { A, comp, undo } = scene();
    expect(() => A.loudnessApply({ comp_id: comp.id, gain_db: 1, fade_scope: "mix", expect: GUARD })).toThrow(/fade_scope/);
    expect(undo.begun).toBe(0);
  });

  it("caps the keys it reports per layer and says so, with the real count", () => {
    const { A, comp, music } = scene();
    for (let i = 0; i < 500; i++) music.levels.setValueAtTime(i * 0.01, [-20, -20]);
    const out = wire(A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_out: 1, expect: GUARD }));
    expect(out.layers[0].keys.length).toBe(500);
    expect(out.layers[0].key_count).toBe(502);
    expect(out.layers[0].keys_truncated).toBe(true);
    const r = wire(A.loudnessRead({ comp_id: comp.id }));
    const m = r.layers.find((l: { name: string }) => l.name === "Music");
    expect(m.levels.num_keys).toBe(502);
    expect(m.levels.keys).toHaveLength(500);
    expect(m.levels.keys_truncated).toBe(true);
    expect(levelsMismatches(null, r, out)).toEqual([]);
  });

  it("stops reading keys when the whole read has returned 5000, and says so per layer", () => {
    const { A, comp, add } = scene();
    for (let l = 0; l < 11; l++) {
      const x = add("Extra" + l, [0, 0]);
      for (let i = 0; i < 500; i++) x.levels.setValueAtTime(i * 0.01, [-20, -20]);
    }
    const r = wire(A.loudnessRead({ comp_id: comp.id }));
    const total = r.layers.reduce((n: number, l: { levels: { keys: unknown[] } }) => n + l.levels.keys.length, 0);
    expect(total).toBe(5000);
    const last = r.layers.filter((l: { levels: { num_keys: number } }) => l.levels.num_keys === 500)[10];
    expect(last.levels.keys.length).toBe(0);
    expect(last.levels.keys_truncated).toBe(true);
    expect(last.levels.num_keys).toBe(500);
  });

  it("reads no keys at all when asked, but still counts them", () => {
    const { A, comp, music } = scene();
    music.levels.setValueAtTime(0, [-3, -3]);
    music.levels.setValueAtTime(2, [-6, -6]);
    const r = wire(A.loudnessRead({ comp_id: comp.id, skip_keys: true }));
    const m = r.layers.find((l: { name: string }) => l.name === "Music");
    expect(m.levels).toMatchObject({ num_keys: 2, keys: [], keys_truncated: true });
    expect(r.layers.find((l: { name: string }) => l.name === "VO").levels.value).toEqual([-6, -6]);
  });

  it("keeps a channel at the property's floor silent", () => {
    const { A, comp, music } = scene();
    music.levels.staticValue = [-192, -6];
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], gain_db: 6, expect: GUARD });
    expect(music.levels.value).toEqual([-192, 0]);
  });

  it("raises the floor of a fade to the property's own minimum", () => {
    const { A, comp, music } = scene();
    Object.assign(music.levels, { minValue: -60 });
    music.levels.staticValue = [-6, -6];
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], fade_in: 1, expect: GUARD });
    expect(music.levels.keys.map((k) => [k.time, k.value])).toEqual([
      [0, [-60, -60]],
      [1, [-6, -6]],
    ]);
  });

  it("clamps to the property's minimum when a negative gain would go under it", () => {
    const { A, comp, vo } = scene();
    vo.levels.staticValue = [-180, -180];
    const out = wire(A.loudnessApply({ comp_id: comp.id, layers: [{ name: "VO" }], gain_db: -30, expect: GUARD }));
    expect(vo.levels.value).toEqual([-192, -192]);
    expect(out.layers[0].clamped).toBe(true);
  });

  it("refuses everything that can fail before changing anything", () => {
    const { A, comp, undo, music, vo } = scene();
    const kind = (args: Record<string, unknown>) => {
      try {
        A.loudnessApply({ comp_id: comp.id, expect: GUARD, ...args });
      } catch (e) {
        return { kind: (e as { __kind?: string }).__kind, message: (e as Error).message };
      }
      return null;
    };
    // A gain past the maximum on the second layer: the first must stay untouched too.
    expect(kind({ gain_db: 40 })).toMatchObject({ kind: "bad_args", message: expect.stringMatching(/above the Audio Levels maximum of 24/) });
    expect(music.levels.value).toEqual([0, 0]);
    expect(vo.levels.value).toEqual([-6, -6]);
    // Fades longer than the layer.
    expect(kind({ fade_in: 6, fade_out: 5 })).toMatchObject({ kind: "bad_args", message: expect.stringMatching(/add up/) });
    // Nothing to do, and bad numbers.
    expect(kind({ gain_db: 0 })).toMatchObject({ kind: "bad_args" });
    expect(kind({ gain_db: Infinity })).toMatchObject({ kind: "bad_args" });
    expect(kind({ gain_db: 1, fade_in: -1 })).toMatchObject({ kind: "bad_args" });
    // Locked, expression, no audio.
    vo.layer.locked = true;
    expect(kind({ gain_db: 1 })).toMatchObject({ kind: "bad_args", message: expect.stringMatching(/locked/) });
    expect(music.levels.value).toEqual([0, 0]);
    vo.layer.locked = false;
    vo.levels.expressionEnabled = true;
    expect(kind({ gain_db: 1 })).toMatchObject({ kind: "bad_args", message: expect.stringMatching(/expression/) });
    vo.levels.expressionEnabled = false;
    vo.layer.hasAudio = false;
    expect(kind({ gain_db: 1, layers: [{ name: "VO" }] })).toMatchObject({ kind: "bad_args", message: expect.stringMatching(/no audio/) });
    // Missing layer, no layers with sound.
    expect(kind({ gain_db: 1, layers: [{ name: "Nope" }] })).toMatchObject({ kind: "not_found" });
    expect(undo.begun).toBe(0);
  });

  it("is refused by the guard when the project is not the expected one", () => {
    const { A, comp, undo, music } = scene();
    let err: { __kind?: string } | null = null;
    try {
      A.loudnessApply({ comp_id: comp.id, gain_db: 1, expect: { project_path: "C:/other.aep" } });
    } catch (e) {
      err = e as { __kind?: string };
    }
    expect(err?.__kind).toBe("guard");
    expect(undo.begun).toBe(0);
    expect(music.levels.value).toEqual([0, 0]);
  });

  it("refuses a comp with no sound", () => {
    const project = new FakeProject();
    const comp = project.addComp("Silent", 640, 360, 5);
    comp.layers.addNull(5);
    const { A } = loadHost(project, ["loudness.jsx"]);
    expect(() => A.loudnessApply({ comp_id: comp.id, gain_db: 1, expect: GUARD })).toThrow(/No layer with audio/);
  });

  it("works when the property reports no limits", () => {
    const { A, comp, music } = scene();
    Object.assign(music.levels, { hasMin: false, hasMax: false });
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], gain_db: 30, fade_in: 1, expect: GUARD });
    expect(music.levels.keys.map((k) => k.value)).toEqual([[-96, -96], [30, 30]]);
  });

  it("falls back to setValueAtTime where setValueAtKey is missing", () => {
    const { A, comp, music } = scene();
    music.levels.setValueAtTime(0, [-6, -6]);
    music.levels.setValueAtTime(2, [-6, -6]);
    (music.levels as unknown as { setValueAtKey?: unknown }).setValueAtKey = undefined;
    A.loudnessApply({ comp_id: comp.id, layers: [{ name: "Music" }], gain_db: 1, expect: GUARD });
    expect(music.levels.keys.map((k) => k.value)).toEqual([[-5, -5], [-5, -5]]);
  });

  it("passes its own receipt: read, apply, read, no mismatches", () => {
    const { A, comp, music } = scene();
    music.levels.setValueAtTime(0, [-9, -9]);
    music.levels.setValueAtTime(3, [-3, -3]);
    const before = wire(A.loudnessRead({ comp_id: comp.id }));
    const written = wire(A.loudnessApply({ comp_id: comp.id, gain_db: 2, fade_in: 0.5, fade_out: 1, expect: GUARD }));
    const after = wire(A.loudnessRead({ comp_id: comp.id }));
    expect(levelsMismatches(before, after, written)).toEqual([]);
    // And it notices a layer that was left out.
    const second = wire(A.loudnessRead({ comp_id: comp.id }));
    second.layers[0].levels.keys[0].value[0] += 5;
    expect(levelsMismatches(before, second, { layers: [] }).length).toBeGreaterThan(0);
  });
});
