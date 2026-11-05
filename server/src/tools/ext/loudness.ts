/**
 * server/src/tools/ext/loudness.ts
 *
 * Loudness tools:
 * - ae_loudness_check: renders a comp's audio with aerender in the background
 *   (the same pass ae_audio_analyze uses), or takes a WAV/AIFF by path, and
 *   measures it the way a delivery check does: integrated loudness (ITU-R
 *   BS.1770-4, K-weighted, 400 ms blocks, -70 LUFS absolute and -10 LU
 *   relative gates), loudness range (EBU Tech 3342), momentary and short-term
 *   maximum, and true peak (polyphase oversampling). It compares the result with
 *   EBU R128, ATSC A/85, a streaming target or a custom one, and says what
 *   gain would meet it and whether that gain breaks the true-peak ceiling.
 * - ae_loudness_apply: a gain on the Audio Levels of the comp's audio layers,
 *   plus fade in / fade out, as one undo group with a read-back. Existing
 *   level keys are offset, not overwritten. AE has no limiter, so a gain that
 *   would break a given true-peak ceiling is refused unless allowed.
 *
 * The DSP is plain JS (the panel runs it on Node 17): no native modules, no
 * outside tools. It yields to the event loop on long audio.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { AudioDecodeError, decodeAudioChannels } from "../../audio.js";
import { SLOW_TIMEOUT_MS } from "../../host.js";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, LayerSelectorSchema, type ToolContext, type ToolDefinition } from "../common.js";
import { aerenderTools, getDefaultAerenderRegistry, type AerenderJobRecord } from "./aerender.js";
import { DEFAULT_AUDIO_TEMPLATE, findRenderedAudio } from "./audio.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

const MAX_ANALYSIS_SECONDS = 20 * 60;
// The file is read whole and decoded to one Float32Array per channel (4 bytes a sample): at most
// the file plus the decoded samples live at once in the panel's Node 17, so the sum is bounded:
// the file may be up to MAX_AUDIO_BYTES, the decoded samples up to MAX_DECODED_BYTES, and both together
// up to TOTAL_AUDIO_BYTES.
const MAX_AUDIO_BYTES = 600 * 1024 * 1024;
const MAX_DECODED_BYTES = 600 * 1024 * 1024;
const TOTAL_AUDIO_BYTES = 1024 * 1024 * 1024;

/** The decoded-sample budget for a file of this size: what is left of the total after the file itself. */
export function decodedBudget(fileBytes: number): number {
  return Math.max(0, Math.min(MAX_DECODED_BYTES, TOTAL_AUDIO_BYTES - fileBytes));
}
/** Renders older than this are deleted when a new loudness render starts. */
const RENDER_KEEP_MS = 24 * 3600 * 1000;

// ---------- DSP ----------

export interface Biquad {
  b: [number, number, number];
  a: [number, number, number];
}

/**
 * BS.1770-4 K-weighting for any sample rate: a high shelf (+4 dB above ~1.7
 * kHz) and the RLB high-pass at ~38 Hz. The standard prints coefficients for
 * 48 kHz only; these come from the analogue prototype by bilinear transform
 * (as libebur128 does) and reproduce the printed 48 kHz values.
 */
export function kWeighting(sampleRate: number): { stage1: Biquad; stage2: Biquad } {
  const f1 = 1681.974450955533;
  const g1 = 3.999843853973347;
  const q1 = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * f1) / sampleRate);
  const vh = 10 ** (g1 / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k1 / q1 + k1 * k1;
  const stage1: Biquad = {
    b: [(vh + (vb * k1) / q1 + k1 * k1) / a0, (2 * (k1 * k1 - vh)) / a0, (vh - (vb * k1) / q1 + k1 * k1) / a0],
    a: [1, (2 * (k1 * k1 - 1)) / a0, (1 - k1 / q1 + k1 * k1) / a0],
  };
  const f2 = 38.13547087602444;
  const q2 = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * f2) / sampleRate);
  const d0 = 1 + k2 / q2 + k2 * k2;
  const stage2: Biquad = {
    b: [1, -2, 1],
    a: [1, (2 * (k2 * k2 - 1)) / d0, (1 - k2 / q2 + k2 * k2) / d0],
  };
  return { stage1, stage2 };
}

/** BS.1770 channel weights: L, R, C 1.0; surrounds 1.41; the LFE of 5.1 is left out. Mono and stereo are 1.0. */
export function channelWeights(channels: number): number[] {
  if (channels === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (channels === 5) return [1, 1, 1, 1.41, 1.41];
  return new Array<number>(channels).fill(1);
}

/** How far to oversample for the true peak: 4x below 96 kHz, 2x up to 192 kHz, none above (BS.1770-4 Annex 2). */
export function oversamplingFor(sampleRate: number): number {
  if (sampleRate < 96000) return 4;
  if (sampleRate < 192000) return 2;
  return 1;
}

const TAPS_PER_PHASE = 24;
/** Kaiser window shape: about 60 dB of image rejection with the passband flat to about 20 kHz at 48 kHz. */
const KAISER_BETA = 5.6;

/** Modified Bessel function of the first kind, order 0 (power series). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

export interface Polyphase {
  factor: number;
  /** phases[p][j] multiplies x[n + half - j]. */
  phases: Float64Array[];
  half: number;
  /** The largest sum of |tap| over a phase: no interpolated value exceeds this times the local sample maximum. */
  l1: number;
}

/** A Kaiser-windowed sinc interpolator, each phase normalised to unity gain at DC. */
export function makePolyphase(factor: number): Polyphase {
  const half = TAPS_PER_PHASE / 2;
  const n = factor * TAPS_PER_PHASE + 1;
  const centre = (factor * TAPS_PER_PHASE) / 2;
  const h = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const x = (k - centre) / factor;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = (2 * k) / (n - 1) - 1;
    const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(KAISER_BETA);
    h[k] = sinc * w;
  }
  const phases: Float64Array[] = [];
  let l1 = 0;
  for (let p = 0; p < factor; p++) {
    const taps: number[] = [];
    for (let k = p; k < n; k += factor) taps.push(h[k]);
    const sum = taps.reduce((a, b) => a + b, 0);
    const norm = Float64Array.from(taps, (v) => v / sum);
    phases.push(norm);
    l1 = Math.max(l1, norm.reduce((a, b) => a + Math.abs(b), 0));
  }
  return { factor, phases, half, l1 };
}

/** Samples at or above this are at full scale for 16-bit audio (32767/32768 = 0.99997). */
const FULL_SCALE = 0.99996;
/** Frames of work between yields to the event loop: the panel's one Node thread serves every MCP request. */
const YIELD_SAMPLES = 4_000_000;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface ChannelPeak {
  sample: number;
  true: number;
  /** Samples in runs of 3 or more at full scale: the file was clipped. Counted for integer PCM only. */
  clipped: number;
  /** Samples whose magnitude is over 1.0 (0 dBFS). Only a float file can hold them. */
  over: number;
}

/**
 * Sample peak, true peak and clipping of one channel. The interpolated phases
 * are only computed where they could beat the best value so far (a stretch
 * whose largest sample times the interpolator's gain bound cannot), so loud,
 * long files cost little more than the sample pass.
 */
export async function channelPeak(x: Float32Array, poly: Polyphase, integerFormat = true): Promise<ChannelPeak> {
  let sample = 0;
  let clipped = 0;
  let over = 0;
  let run = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > sample) sample = a;
    if (a > 1) over++;
    if (integerFormat && a >= FULL_SCALE) {
      run++;
      if (run === 3) clipped += 3;
      else if (run > 3) clipped++;
    } else run = 0;
    if (i % YIELD_SAMPLES === YIELD_SAMPLES - 1) await yieldToLoop();
  }
  let best = sample;
  if (poly.factor > 1) {
    const { half, phases } = poly;
    const chunk = 512;
    let worked = 0;
    for (let a = 0; a < x.length; a += chunk) {
      const b = Math.min(x.length, a + chunk);
      let m = 0;
      for (let i = Math.max(0, a - half); i < Math.min(x.length, b + half); i++) {
        const v = Math.abs(x[i]);
        if (v > m) m = v;
      }
      if (m * poly.l1 <= best) continue;
      for (let n = a; n < b; n++) {
        for (let p = 1; p < phases.length; p++) {
          const taps = phases[p];
          let acc = 0;
          for (let j = 0; j < taps.length; j++) {
            const idx = n + half - j;
            if (idx >= 0 && idx < x.length) acc += taps[j] * x[idx];
          }
          const v = Math.abs(acc);
          if (v > best) best = v;
        }
      }
      worked += b - a;
      if (worked >= YIELD_SAMPLES / 8) {
        worked = 0;
        await yieldToLoop();
      }
    }
  }
  return { sample, true: best, clipped, over };
}

const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE = -70;

/** Mean-square energy to LUFS. */
export const lufsOf = (power: number): number => (power > 0 ? LUFS_OFFSET + 10 * Math.log10(power) : -Infinity);

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const finiteOrNull = (x: number) => (Number.isFinite(x) ? x : null);
const dbOf = (amp: number): number | null => (amp > 0 ? round1(20 * Math.log10(amp)) : null);

/** The p-quantile (0..1) of a sorted array, interpolated between neighbours. */
export function quantile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return NaN;
  const at = p * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Integrated loudness of block powers (BS.1770-4): the absolute gate, then a relative gate 10 LU under what is left. */
export function gatedLoudness(powers: ArrayLike<number>): { lufs: number | null; aboveAbsolute: number; gated: number } {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < powers.length; i++) {
    if (lufsOf(powers[i]) > ABSOLUTE_GATE) {
      sum += powers[i];
      count++;
    }
  }
  if (count === 0) return { lufs: null, aboveAbsolute: 0, gated: 0 };
  const relative = lufsOf(sum / count) - 10;
  let gsum = 0;
  let gcount = 0;
  for (let i = 0; i < powers.length; i++) {
    const l = lufsOf(powers[i]);
    if (l > ABSOLUTE_GATE && l > relative) {
      gsum += powers[i];
      gcount++;
    }
  }
  return { lufs: gcount ? lufsOf(gsum / gcount) : null, aboveAbsolute: count, gated: gcount };
}

/** Loudness range (EBU Tech 3342): short-term values above -70 LUFS, those within 20 LU of their power mean, 10th to 95th percentile. */
export function loudnessRange(shortTermPowers: ArrayLike<number>): number | null {
  const above: number[] = [];
  let sum = 0;
  for (let i = 0; i < shortTermPowers.length; i++) {
    if (lufsOf(shortTermPowers[i]) > ABSOLUTE_GATE) {
      above.push(shortTermPowers[i]);
      sum += shortTermPowers[i];
    }
  }
  if (!above.length) return null;
  const relative = lufsOf(sum / above.length) - 20;
  const kept = above.map(lufsOf).filter((l) => l > relative).sort((a, b) => a - b);
  if (!kept.length) return null;
  return quantile(kept, 0.95) - quantile(kept, 0.1);
}

export interface LoudnessWindow {
  start: number;
  end: number;
  lufs: number;
  kind: "short_term_3s" | "momentary_400ms";
}

export interface LoudnessMeasurement {
  duration: number;
  sample_rate: number;
  channels: number;
  /** null: nothing above the -70 LUFS gate (silence). */
  integrated_lufs: number | null;
  /** null: under 3 s of audio, or nothing above the gate. */
  loudness_range_lu: number | null;
  momentary_max_lufs: number | null;
  short_term_max_lufs: number | null;
  /** The loudest and the quietest (above the -70 LUFS gate) 3 s window; 400 ms blocks for audio under 3 s. In file seconds. */
  loudest_window: LoudnessWindow | null;
  quietest_window: LoudnessWindow | null;
  true_peak_dbtp: number | null;
  sample_peak_dbfs: number | null;
  true_peak_per_channel_dbtp: Array<number | null>;
  oversampling: number;
  blocks: { total: number; above_absolute_gate: number; gated: number };
  /** Samples in full-scale runs of an integer file: the render was clipped, so these numbers describe the clipped file. */
  clipped_samples: number;
  /** Samples over 0 dBFS in a float file: not clipped there, but they clip when delivered as integer audio. */
  over_samples: number;
}

export interface MeasureOptions {
  /** The file holds float samples: full-scale runs are not clipping there. Default false (integer PCM). */
  float?: boolean;
}

/** True for a decoded format string that holds float samples (wav float, aifc fl32 / fl64). */
export const isFloatFormat = (format: string): boolean => /float|fl32|fl64/i.test(format);

/**
 * Measures loudness, loudness range and peaks of per-channel audio. Energy is
 * summed over the K-weighted channels (not averaged into mono, which reads up
 * to 3 dB low on correlated stereo). 100 ms sub-blocks are summed into 400 ms
 * momentary blocks (75 % overlap) and 3 s short-term windows.
 */
export async function measureLoudness(channels: Float32Array[], sampleRate: number, options: MeasureOptions = {}): Promise<LoudnessMeasurement> {
  const frames = channels[0]?.length ?? 0;
  const step = Math.max(1, Math.round(0.1 * sampleRate));
  const nSub = Math.floor(frames / step);
  const sub = new Float64Array(nSub);
  const weights = channelWeights(channels.length);
  const { stage1, stage2 } = kWeighting(sampleRate);
  const [b10, b11, b12] = stage1.b;
  const [, a11, a12] = stage1.a;
  const [b20, b21, b22] = stage2.b;
  const [, a21, a22] = stage2.a;
  let since = 0;
  for (let c = 0; c < channels.length; c++) {
    const w = weights[c];
    if (w === 0) continue;
    const x = channels[c];
    let s11 = 0;
    let s12 = 0;
    let s21 = 0;
    let s22 = 0;
    for (let j = 0; j < nSub; j++) {
      let acc = 0;
      const end = (j + 1) * step;
      for (let i = j * step; i < end; i++) {
        const v = x[i];
        // Transposed direct form II, two stages.
        const y1 = b10 * v + s11;
        s11 = b11 * v - a11 * y1 + s12;
        s12 = b12 * v - a12 * y1;
        const y = b20 * y1 + s21;
        s21 = b21 * y1 - a21 * y + s22;
        s22 = b22 * y1 - a22 * y;
        acc += y * y;
      }
      sub[j] += w * acc;
      since += step;
      if (since >= YIELD_SAMPLES) {
        since = 0;
        await yieldToLoop();
      }
    }
  }

  const prefix = new Float64Array(nSub + 1);
  for (let j = 0; j < nSub; j++) prefix[j + 1] = prefix[j] + sub[j];
  const nBlocks = Math.max(0, nSub - 3);
  const blockPower = new Float64Array(nBlocks);
  for (let k = 0; k < nBlocks; k++) blockPower[k] = (prefix[k + 4] - prefix[k]) / (4 * step);
  const nShort = Math.max(0, nSub - 29);
  const shortPower = new Float64Array(nShort);
  for (let k = 0; k < nShort; k++) shortPower[k] = (prefix[k + 30] - prefix[k]) / (30 * step);

  const gate = gatedLoudness(blockPower);
  let momentaryMax = -Infinity;
  for (let k = 0; k < nBlocks; k++) momentaryMax = Math.max(momentaryMax, lufsOf(blockPower[k]));
  let shortMax = -Infinity;
  for (let k = 0; k < nShort; k++) shortMax = Math.max(shortMax, lufsOf(shortPower[k]));

  // Loudest and quietest windows: 3 s ones when the audio is long enough, 400 ms blocks otherwise.
  const useShort = nShort > 0;
  const series = useShort ? shortPower : blockPower;
  const span = useShort ? 3 : 0.4;
  const kind = useShort ? ("short_term_3s" as const) : ("momentary_400ms" as const);
  let loudest: LoudnessWindow | null = null;
  let quietest: LoudnessWindow | null = null;
  let loudAt = -1;
  let quietAt = -1;
  for (let k = 0; k < series.length; k++) {
    const l = lufsOf(series[k]);
    if (l <= ABSOLUTE_GATE) continue;
    if (loudAt < 0 || l > lufsOf(series[loudAt])) loudAt = k;
    if (quietAt < 0 || l < lufsOf(series[quietAt])) quietAt = k;
  }
  const windowAt = (k: number): LoudnessWindow => {
    const start = (k * step) / sampleRate;
    return { start: round3(start), end: round3(start + span), lufs: round1(lufsOf(series[k])), kind };
  };
  if (loudAt >= 0) loudest = windowAt(loudAt);
  if (quietAt >= 0) quietest = windowAt(quietAt);

  const poly = makePolyphase(oversamplingFor(sampleRate));
  const peaks: ChannelPeak[] = [];
  for (const x of channels) peaks.push(await channelPeak(x, poly, !options.float));
  const samplePeak = peaks.reduce((m, p) => Math.max(m, p.sample), 0);
  const truePeak = peaks.reduce((m, p) => Math.max(m, p.true), 0);

  const range = loudnessRange(shortPower);
  const integrated = gate.lufs;
  return {
    duration: round3(frames / sampleRate),
    sample_rate: sampleRate,
    channels: channels.length,
    integrated_lufs: integrated === null ? null : round1(integrated),
    loudness_range_lu: range === null ? null : round1(range),
    momentary_max_lufs: finiteOrNull(momentaryMax) === null ? null : round1(momentaryMax),
    short_term_max_lufs: finiteOrNull(shortMax) === null ? null : round1(shortMax),
    loudest_window: loudest,
    quietest_window: quietest,
    true_peak_dbtp: dbOf(truePeak),
    sample_peak_dbfs: dbOf(samplePeak),
    true_peak_per_channel_dbtp: peaks.map((p) => dbOf(p.true)),
    oversampling: poly.factor,
    blocks: { total: nBlocks, above_absolute_gate: gate.aboveAbsolute, gated: gate.gated },
    clipped_samples: peaks.reduce((n, p) => n + p.clipped, 0),
    over_samples: peaks.reduce((n, p) => n + p.over, 0),
  };
}

// ---------- standards and the verdict ----------

export interface LoudnessStandard {
  name: string;
  target_lufs: number;
  true_peak_max_db: number;
  tolerance_lu: number;
}

export const STANDARDS = {
  ebu_r128: { name: "EBU R128", target_lufs: -23, true_peak_max_db: -1, tolerance_lu: 0.5 },
  atsc_a85: { name: "ATSC A/85", target_lufs: -24, true_peak_max_db: -2, tolerance_lu: 2 },
  streaming: { name: "Streaming (-14 LUFS)", target_lufs: -14, true_peak_max_db: -1, tolerance_lu: 1 },
} satisfies Record<string, LoudnessStandard>;

export interface StandardChoice {
  standard?: "ebu_r128" | "atsc_a85" | "streaming" | "custom";
  target_lufs?: number;
  true_peak_max_db?: number;
  tolerance_lu?: number;
}

/** The named standard with any given numbers laid over it. 'custom' starts from -23 / -1 / 1 LU. */
export function resolveStandard(c: StandardChoice): LoudnessStandard {
  const key = c.standard ?? "ebu_r128";
  const base: LoudnessStandard = key === "custom" ? { name: "Custom", target_lufs: -23, true_peak_max_db: -1, tolerance_lu: 1 } : STANDARDS[key];
  return {
    name: base.name,
    target_lufs: c.target_lufs ?? base.target_lufs,
    true_peak_max_db: c.true_peak_max_db ?? base.true_peak_max_db,
    tolerance_lu: c.tolerance_lu ?? base.tolerance_lu,
  };
}

export interface LoudnessVerdict {
  measurable: boolean;
  passes: boolean;
  loudness_ok: boolean;
  true_peak_ok: boolean;
  /** Integrated minus target, in LU. */
  deviation_lu: number | null;
  /** The gain that lands on the target. */
  gain_needed_db: number | null;
  /** True peak after that gain. */
  true_peak_after_gain_dbtp: number | null;
  /** True when that gain would take the true peak over the ceiling (AE has no limiter to catch it). */
  peak_conflict: boolean;
  /** The most gain the true-peak ceiling allows. */
  max_gain_within_peak_db: number | null;
  /** The loudness reached at that most-gain, when it is less than the target. */
  lufs_at_peak_limit: number | null;
  advice: string[];
}

export function assessLoudness(m: LoudnessMeasurement, std: LoudnessStandard): LoudnessVerdict {
  const advice: string[] = [];
  if (m.clipped_samples > 0) {
    advice.push(
      `${m.clipped_samples} samples sit at full scale: the render was clipped at 0 dBFS, so these numbers describe the clipped file, not the mix. Lower the levels (a negative gain) and measure again.`
    );
  }
  if (m.over_samples > 0) {
    advice.push(
      `${m.over_samples} samples of this float file are over 0 dBFS. They are intact here, but they clip when the mix is delivered as 16 or 24-bit audio: lower the levels (a negative gain) if that is the delivery.`
    );
  }
  if (m.integrated_lufs === null) {
    advice.push("Nothing in the audio is above the -70 LUFS gate: it is silent, or the audio layers are muted or out of the measured range.");
    return {
      measurable: false,
      passes: false,
      loudness_ok: false,
      true_peak_ok: m.true_peak_dbtp === null || m.true_peak_dbtp <= std.true_peak_max_db,
      deviation_lu: null,
      gain_needed_db: null,
      true_peak_after_gain_dbtp: null,
      peak_conflict: false,
      max_gain_within_peak_db: null,
      lufs_at_peak_limit: null,
      advice,
    };
  }
  const deviation = m.integrated_lufs - std.target_lufs;
  const gain = std.target_lufs - m.integrated_lufs;
  const loudnessOk = Math.abs(deviation) <= std.tolerance_lu + 1e-9;
  const tp = m.true_peak_dbtp;
  const tpOk = tp === null || tp <= std.true_peak_max_db + 1e-9;
  const after = tp === null ? null : round1(tp + gain);
  const headroom = tp === null ? null : round1(std.true_peak_max_db - tp);
  const conflict = !loudnessOk && gain > 0 && after !== null && after > std.true_peak_max_db + 1e-9;
  if (loudnessOk && tpOk) {
    advice.push(`Meets ${std.name}: ${m.integrated_lufs} LUFS (target ${std.target_lufs} ±${std.tolerance_lu} LU) and a true peak of ${tp} dBTP (limit ${std.true_peak_max_db}).`);
  }
  if (!loudnessOk) {
    const dir = gain > 0 ? "quieter" : "louder";
    advice.push(`${m.integrated_lufs} LUFS is ${Math.abs(round1(deviation))} LU ${dir} than the target ${std.target_lufs} LUFS (±${std.tolerance_lu}). A gain of ${gain > 0 ? "+" : ""}${round1(gain)} dB lands on the target.`);
  }
  if (!tpOk) {
    advice.push(`The true peak ${tp} dBTP is over the ${std.true_peak_max_db} dBTP limit by ${round1((tp as number) - std.true_peak_max_db)} dB; only a negative gain (or a limiter outside AE) fixes that.`);
  }
  let atLimit: number | null = null;
  if (conflict && headroom !== null) {
    atLimit = round1(m.integrated_lufs + Math.max(0, headroom));
    advice.push(
      `Loudness and true peak conflict: +${round1(gain)} dB would put the true peak at ${after} dBTP, over the ${std.true_peak_max_db} limit. ` +
        `The peak limit allows at most +${Math.max(0, headroom)} dB, which reaches ${atLimit} LUFS. AE has no limiter, so choose one: the loudness target or the peak ceiling. ` +
        "ae_loudness_apply refuses the gain unless allow_over_peak is set."
    );
  }
  return {
    measurable: true,
    passes: loudnessOk && tpOk,
    loudness_ok: loudnessOk,
    true_peak_ok: tpOk,
    deviation_lu: round1(deviation),
    gain_needed_db: round1(gain),
    true_peak_after_gain_dbtp: after,
    peak_conflict: conflict,
    max_gain_within_peak_db: headroom,
    lufs_at_peak_limit: atLimit,
    advice,
  };
}

// ---------- schemas ----------

const StandardField = z
  .enum(["ebu_r128", "atsc_a85", "streaming", "custom"])
  .optional()
  .describe(
    "What to compare with. ebu_r128: -23 LUFS ±0.5 LU, true peak -1 dBTP. atsc_a85: -24 LKFS ±2 LU, -2 dBTP. streaming: -14 LUFS ±1 LU, -1 dBTP. custom: start from -23 / -1 / ±1 and set the numbers. Default ebu_r128."
  );

export const AeLoudnessCheckSchema = z
  .object({
    comp_id: z.number().int().optional().describe("Render this comp's audio with aerender and measure it. The project must be saved, with no unsaved changes. Needs expect."),
    expect: ExpectSchema.optional().describe("Required with comp_id."),
    start: z.number().min(0).optional().describe("With comp_id: comp seconds to start the render at. Default 0."),
    end: z.number().positive().optional().describe("With comp_id: comp seconds to end at. Default the comp's end."),
    output_module_template: z
      .string()
      .min(1)
      .optional()
      .describe(`With comp_id: an audio-only output-module template. Default '${DEFAULT_AUDIO_TEMPLATE}' (16-bit, so a mix over 0 dBFS is clipped in the file; the result says so).`),
    job_id: z.string().min(1).optional().describe("Collect the measurement of a render started earlier (by this tool or ae_audio_analyze)."),
    audio_path: z.string().min(1).optional().describe("Measure this WAV or AIFF (absolute path) instead; nothing is rendered."),
    time_offset: z.number().optional().describe("With audio_path: seconds added to the window times (e.g. the audio layer's start in the comp)."),
    wait_seconds: z.number().min(0).max(120).optional().describe("How long to wait for the render before returning a job_id. Default 30."),
    standard: StandardField,
    target_lufs: z.number().min(-70).max(0).optional().describe("Target integrated loudness in LUFS; overrides the standard's."),
    true_peak_max_db: z.number().min(-30).max(3).optional().describe("True-peak ceiling in dBTP; overrides the standard's."),
    tolerance_lu: z.number().min(0).max(10).optional().describe("How far from the target still counts as meeting it, in LU; overrides the standard's."),
  })
  .refine((v) => [v.comp_id, v.job_id, v.audio_path].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one of comp_id, job_id or audio_path.",
  })
  .refine((v) => v.comp_id === undefined || v.expect !== undefined, { message: "comp_id needs expect." })
  .refine((v) => v.comp_id !== undefined || (v.start === undefined && v.end === undefined && v.output_module_template === undefined), {
    message: "start, end and output_module_template only apply with comp_id (they set the render); they are ignored for audio_path and job_id.",
  })
  .refine((v) => v.audio_path !== undefined || v.time_offset === undefined, { message: "time_offset only applies with audio_path." })
  .refine((v) => v.start === undefined || v.end === undefined || v.end > v.start, { message: "end must be after start." })
  .refine((v) => v.standard !== "custom" || v.target_lufs !== undefined, { message: "standard 'custom' needs target_lufs." });

export const AeLoudnessApplySchema = z
  .object({
    comp_id: z.number().int(),
    layers: z
      .array(LayerSelectorSchema)
      .min(1)
      .max(500)
      .optional()
      .describe("The layers to change. Default: every layer with audio switched on (precomp layers included: their own Audio Levels carry the mix)."),
    gain_db: z
      .number()
      .min(-96)
      .max(48)
      .optional()
      .describe("dB added to each layer's Audio Levels (both channels). Level keys are all offset by it; a channel already at the property's floor stays silent. Use ae_loudness_check's gain_needed_db."),
    fade_in: z
      .number()
      .min(0)
      .max(3600)
      .optional()
      .describe("Seconds of fade in from fade_floor_db (or the layer's level if lower) up to the level. With fade_scope 'comp' (default) one ramp runs over the comp's first fade_in seconds, and a layer that starts during it gets the part of the ramp that falls on it. With 'layer' each layer fades in from its own in point."),
    fade_out: z
      .number()
      .min(0)
      .max(3600)
      .optional()
      .describe("Seconds of fade out to fade_floor_db (or the layer's level if lower). With fade_scope 'comp' (default) one ramp runs over the comp's last fade_out seconds, and a layer that ends during it gets the part of the ramp that falls on it; with 'layer' each layer fades out ending at its own out point."),
    fade_scope: z
      .enum(["comp", "layer"])
      .optional()
      .describe("'comp' (default): fade the mix, at the start and end of the comp. 'layer': fade every layer at its own in and out points."),
    fade_floor_db: z.number().min(-192).max(-6).optional().describe("The level a fade starts or ends at (a layer already below it keeps its own level). Default -96 (raised to the property's own minimum if that is higher)."),
    true_peak_db: z.number().min(-200).max(30).optional().describe("The measured true peak (ae_loudness_check's true_peak_dbtp), to check the gain against the ceiling."),
    true_peak_max_db: z.number().min(-30).max(3).optional().describe("The true-peak ceiling in dBTP. With true_peak_db: a gain that takes the peak over it is refused."),
    allow_over_peak: z.boolean().optional().describe("Apply a gain that breaks the ceiling anyway (the render will clip). Default false."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.gain_db !== undefined && v.gain_db !== 0) || (v.fade_in ?? 0) > 0 || (v.fade_out ?? 0) > 0, {
    message: "Give a gain_db other than 0, or a fade_in or fade_out.",
  })
  .refine((v) => (v.true_peak_db === undefined) === (v.true_peak_max_db === undefined), {
    message: "true_peak_db and true_peak_max_db go together.",
  });

// ---------- read-back of Audio Levels ----------

export interface LevelsInfo {
  value: number[] | null;
  num_keys: number;
  keys: Array<{ time: number; value: number[] }>;
  keys_truncated: boolean;
  min: number | null;
  max: number | null;
  expression: boolean;
}

export interface SoundLayer {
  index: number;
  id: number;
  name: string;
  kind: string;
  audio_enabled: boolean;
  locked: boolean;
  inPoint: number;
  outPoint: number;
  levels: LevelsInfo | null;
}

export interface LoudnessCompInfo {
  comp_id: number;
  name: string;
  name_unique: boolean;
  duration: number;
  fps: number;
  frame_duration: number;
  display_start_time: number;
  layers: SoundLayer[];
  truncated?: boolean;
  project_path: string;
  dirty: boolean | null;
}

export interface WrittenLevels {
  index: number;
  id: number;
  name: string;
  mode: "static" | "keys";
  value: number[] | null;
  keys: Array<{ time: number; value: number[] }>;
  /** How many keys the layer ends up with (keys may hold fewer: it is capped). */
  key_count?: number;
  keys_truncated?: boolean;
  fade_in?: number;
  fade_out?: number;
  clamped: boolean;
}

const VALUE_TOLERANCE = 0.02;

const compOf = (v: unknown): LoudnessCompInfo | null => (v && typeof v === "object" && Array.isArray((v as LoudnessCompInfo).layers) ? (v as LoudnessCompInfo) : null);

function pairsDiffer(want: number[], got: number[] | null | undefined): boolean {
  if (!got) return true;
  const n = Math.min(want.length, got.length);
  for (let i = 0; i < n; i++) if (Math.abs(want[i] - got[i]) > VALUE_TOLERANCE) return true;
  return false;
}

const levelsSame = (a: LevelsInfo | null | undefined, b: LevelsInfo | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  if (a.num_keys !== b.num_keys) return false;
  if (a.num_keys === 0) return !(a.value && pairsDiffer(a.value, b.value));
  const n = Math.min(a.keys.length, b.keys.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(a.keys[i].time - b.keys[i].time) > 0.0015 || pairsDiffer(a.keys[i].value, b.keys[i].value)) return false;
  }
  return true;
};

/**
 * Compares the Audio Levels read after the write with what the host reports it
 * set (static value, or every key), and checks no other layer's levels moved.
 * A read-back cut at its key cap checks the keys it holds; the rest is not
 * flagged (the result says it was capped).
 */
export function levelsMismatches(beforeRaw: unknown, afterRaw: unknown, written: Record<string, unknown>): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = compOf(beforeRaw);
  const after = compOf(afterRaw);
  if (!after) return m;
  const cut = after.truncated === true;
  const wrote = (written.layers as WrittenLevels[] | undefined) ?? [];
  const tol = Math.max(0.0015, (after.frame_duration || 0) / 2);
  const touched = new Set<number>();
  for (const w of wrote) {
    touched.add(w.id);
    const now = after.layers.find((l) => l.id === w.id);
    const where = `layers[${w.name}].levels`;
    if (!now) {
      if (!cut) m.push({ path: where, expected: "present", actual: undefined, message: `"${w.name}" is not in the read-back` });
      continue;
    }
    const lv = now.levels;
    if (!lv) {
      m.push({ path: where, expected: "Audio Levels", actual: null, message: `"${w.name}" has no Audio Levels in the read-back` });
      continue;
    }
    if (w.mode === "static") {
      expectThat(m, lv.num_keys === 0, `${where}.num_keys`, 0, lv.num_keys, `"${w.name}" gained keys; expected a plain value`);
      if (w.value && lv.num_keys === 0 && pairsDiffer(w.value, lv.value)) {
        m.push({ path: `${where}.value`, expected: w.value, actual: lv.value, message: `"${w.name}" Audio Levels differ from what was set` });
      }
      continue;
    }
    const wantCount = w.key_count ?? w.keys.length;
    expectThat(m, lv.num_keys === wantCount, `${where}.num_keys`, wantCount, lv.num_keys, `"${w.name}" has a different number of level keys than were set`);
    // Keys closer together than the time tolerance must not be matched to each other's read-back.
    const times = w.keys.map((k) => k.time).sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
    const useTol = Math.min(tol, gap * 0.45);
    const lastSeen = lv.keys.length ? lv.keys[lv.keys.length - 1].time : -Infinity;
    for (const k of w.keys) {
      if (lv.keys_truncated && k.time > lastSeen + useTol) continue;
      let got: { time: number; value: number[] } | undefined;
      for (const x of lv.keys) {
        const d = Math.abs(x.time - k.time);
        if (d <= useTol && (!got || d < Math.abs(got.time - k.time))) got = x;
      }
      if (!got) {
        m.push({ path: `${where}@${k.time}`, expected: k.value, actual: undefined, message: `"${w.name}" has no level key at ${k.time}s` });
      } else if (pairsDiffer(k.value, got.value)) {
        m.push({ path: `${where}@${k.time}`, expected: k.value, actual: got.value, message: `"${w.name}" level key at ${k.time}s differs from what was set` });
      }
    }
  }
  if (before) {
    for (const l of after.layers) {
      if (touched.has(l.id)) continue;
      const was = before.layers.find((x) => x.id === l.id);
      if (was && !levelsSame(was.levels, l.levels)) {
        m.push({ path: `layers[${l.name}].levels`, expected: was.levels, actual: l.levels, message: `The Audio Levels of "${l.name}" changed, but it was not a target` });
      }
    }
  }
  return m;
}

// ---------- render plumbing ----------

interface LoudnessJobMeta {
  comp_id: number;
  comp_name: string;
  /** Comp time of the render's first sample. */
  offset: number;
  fps: number;
  output_path: string;
}

export interface LoudnessToolsOptions {
  /** Starts the render; default: the ae_aerender_start tool. */
  startRender?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ job_id?: string; ok?: boolean }>;
  /** Reads a render job; default: the aerender job registry. */
  getJob?: (jobId: string) => Pick<AerenderJobRecord, "state" | "output_path" | "error" | "log_path"> | undefined;
  rendersDir?: () => string;
  pollMs?: number;
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "comp";
}

/** Deletes loudness_* renders (and their sidecars) older than RENDER_KEEP_MS from the audio renders folder. */
export function pruneOldRenders(dir: string, now = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!/^loudness_.+\.(aif|aiff|aifc|wav)(\.json)?$/i.test(n)) continue;
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > RENDER_KEEP_MS) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {
      // Gone or in use: leave it for next time.
    }
  }
  return removed;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

export interface ApplyHint {
  gain_db: number;
  true_peak_db?: number;
  true_peak_max_db: number;
  reaches_lufs: number;
  note: string;
}

/**
 * Arguments for ae_loudness_apply that the tool will accept. The full gain to the target when it keeps the
 * true peak under the ceiling; with a conflict, the most gain the ceiling allows (and the loudness that reaches);
 * with a true peak already over the ceiling, the negative gain that brings it under (or the gain to the target
 * when that is lower still). Null when the right gain is under 0.05 dB.
 */
export function applyHint(m: LoudnessMeasurement, std: LoudnessStandard, verdict: LoudnessVerdict): ApplyHint | null {
  if (!verdict.measurable || verdict.gain_needed_db === null || m.integrated_lufs === null) return null;
  if (verdict.passes) return null;
  let gain = Math.round((std.target_lufs - m.integrated_lufs) * 100) / 100;
  let note = "Arguments for ae_loudness_apply. Then ae_save and measure again: the property read-back only confirms the dB values, not the new loudness.";
  const tp = m.true_peak_dbtp;
  if (!verdict.true_peak_ok && tp !== null) {
    const down = Math.round((std.true_peak_max_db - tp) * 100) / 100;
    if (down < gain) {
      gain = down;
      note = `The true peak is over the ceiling, so this is the negative gain that brings it to ${std.true_peak_max_db} dBTP; the loudness then reaches ${round1(m.integrated_lufs + gain)} LUFS (target ${std.target_lufs}). ` + note;
    }
  } else if (verdict.peak_conflict && verdict.max_gain_within_peak_db !== null) {
    gain = Math.max(0, Math.round(verdict.max_gain_within_peak_db * 100) / 100);
    note = `The full gain to the target would break the true-peak ceiling, so this is the most the ceiling allows; the loudness reaches ${verdict.lufs_at_peak_limit} LUFS (target ${std.target_lufs}). ` + note;
  }
  // Whatever the verdict says, a boost never takes the true peak over the ceiling (ae_loudness_apply refuses that)
  // and the gain stays inside what ae_loudness_apply accepts.
  if (gain > 0 && tp !== null) {
    const room = Math.max(0, Math.floor((std.true_peak_max_db - tp) * 100) / 100);
    if (gain > room) {
      gain = room;
      if (!verdict.peak_conflict) note = `The true peak leaves only ${room} dB of room under ${std.true_peak_max_db} dBTP, so the gain is held there. ` + note;
    }
  }
  gain = Math.max(-96, Math.min(48, gain));
  if (Math.abs(gain) < 0.05) return null;
  return {
    gain_db: gain,
    ...(tp !== null ? { true_peak_db: tp } : {}),
    true_peak_max_db: std.true_peak_max_db,
    reaches_lufs: round1(m.integrated_lufs + gain),
    note,
  };
}

async function measureFile(file: string, offset: number, choice: StandardChoice, maxSeconds = MAX_ANALYSIS_SECONDS, wholeFile = false) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_AUDIO_BYTES) {
    const mb = MAX_AUDIO_BYTES / 1048576;
    throw new AudioDecodeError(
      wholeFile
        ? `Audio file is over ${mb} MB. audio_path files are measured whole: trim the file, or render the comp with comp_id and start/end`
        : `Audio file is over ${mb} MB; measure a shorter range`
    );
  }
  // The header's length is checked before any sample is decoded.
  let decoded: ReturnType<typeof decodeAudioChannels>;
  try {
    decoded = decodeAudioChannels(await fs.promises.readFile(file), { maxSeconds, maxDecodedBytes: decodedBudget(stat.size) });
  } catch (err) {
    // start/end only exist with comp_id; an audio_path file is always decoded whole.
    if (wholeFile && err instanceof AudioDecodeError && err.message.includes("use start/end")) {
      const cut = err.message.replace(" (use start/end)", "").replace(". Measure a shorter range", "").replace(/[.;]\s*$/, "");
      throw new AudioDecodeError(cut + ". audio_path files are measured whole: trim the file, or render the comp with comp_id and start/end");
    }
    throw err;
  }
  const m = await measureLoudness(decoded.channelData, decoded.sampleRate, { float: isFloatFormat(decoded.format) });
  const std = resolveStandard(choice);
  const verdict = assessLoudness(m, std);
  const hint = applyHint(m, std, verdict);
  const shift = (w: LoudnessWindow | null) => (w ? { ...w, start: round3(w.start + offset), end: round3(w.end + offset) } : null);
  const { loudest_window, quietest_window, ...rest } = m;
  return {
    source: { path: file, format: decoded.format, sample_rate: decoded.sampleRate, channels: decoded.channels, duration: m.duration },
    time_offset: offset,
    standard: std,
    measurement: rest,
    loudest_window: shift(loudest_window),
    quietest_window: shift(quietest_window),
    clipped_in_render: m.clipped_samples > 0,
    verdict,
    ...(hint ? { apply_hint: hint } : {}),
  };
}

export function createLoudnessTools(options: LoudnessToolsOptions = {}): ToolDefinition<any>[] {
  const startRender =
    options.startRender ??
    (async (args: Record<string, unknown>, ctx: ToolContext) => {
      const tool = aerenderTools.find((t) => t.name === "ae_aerender_start")!;
      return (await tool.handler(args, ctx)) as { job_id?: string; ok?: boolean };
    });
  const getJob = options.getJob ?? ((id: string) => getDefaultAerenderRegistry().get(id));
  const rendersDir = options.rendersDir ?? (() => getDefaultAerenderRegistry().rendersDir);
  const pollMs = options.pollMs ?? 250;
  const jobs = new Map<string, LoudnessJobMeta>();

  const metaFor = (jobId: string): LoudnessJobMeta | undefined => {
    const known = jobs.get(jobId);
    if (known) return known;
    // After a restart, or a job ae_audio_analyze started: the sidecar written next to the render.
    const job = getJob(jobId);
    if (!job) return undefined;
    try {
      return JSON.parse(fs.readFileSync(`${job.output_path}.json`, "utf8")) as LoudnessJobMeta;
    } catch {
      return undefined;
    }
  };

  async function collect(jobId: string, waitSeconds: number, choice: StandardChoice) {
    const meta = metaFor(jobId);
    if (!meta) return { ok: false, error: "unknown_job", message: `No audio render with job_id ${jobId}` };
    const deadline = Date.now() + waitSeconds * 1000;
    let job = getJob(jobId);
    while (job?.state === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      job = getJob(jobId);
    }
    if (!job) return { ok: false, error: "unknown_job", message: `The render job ${jobId} is gone` };
    if (job.state === "running") {
      return { ok: true, state: "rendering", job_id: jobId, message: "Still rendering. Call ae_loudness_check again with this job_id." };
    }
    if (job.state === "failed") {
      return {
        ok: false,
        error: "render_failed",
        job_id: jobId,
        message:
          `aerender failed: ${job.error ?? "see the log"}. If the log says the output-module template is missing, ` +
          `pass output_module_template with an audio-only template that exists in this AE (ae_render_templates lists them).`,
        log_path: job.log_path,
      };
    }
    const file = findRenderedAudio(meta.output_path);
    if (!file) return { ok: false, error: "no_output", job_id: jobId, message: `aerender finished but wrote no audio file at ${meta.output_path}` };
    try {
      return {
        ok: true,
        state: "done",
        job_id: jobId,
        comp_id: meta.comp_id,
        ...(await measureFile(file, meta.offset, choice, MAX_ANALYSIS_SECONDS + 2 / (meta.fps || 25))),
      };
    } catch (err) {
      if (err instanceof AudioDecodeError) return { ok: false, error: "bad_audio", job_id: jobId, message: err.message };
      throw err;
    }
  }

  return [
    {
      name: "ae_loudness_check",
      description:
        "Measure a comp's loudness the way a delivery check does: integrated loudness in LUFS (ITU-R BS.1770-4: K-weighted, 400 ms blocks, -70 LUFS and -10 LU gates), loudness range in LU (EBU Tech 3342), momentary and short-term maximum, " +
        "true peak in dBTP (oversampled), and the loudest and quietest 3 s windows (comp seconds). It compares the result with EBU R128 (-23 LUFS, -1 dBTP), ATSC A/85 (-24, -2), streaming (-14, -1) or your own numbers, " +
        "and returns the gain that meets the target, whether that gain breaks the true-peak ceiling (AE has no limiter, so it can't have both), and the arguments for ae_loudness_apply. " +
        "With comp_id the audio is rendered by aerender in the background (AE stays usable; default template 'AIFF 48kHz', 16-bit, so a mix over 0 dBFS arrives clipped and the result says so); " +
        "the project must be saved with no unsaved changes (ae_save first). The rendered AIFF and its .json note stay in the renders folder's audio subfolder (so a job_id can be collected again) and are deleted after 24 hours, when the next render starts. If the render takes longer than wait_seconds the result is a job_id to call again with. With audio_path a WAV or AIFF is measured directly. " +
        "Plain JS on the server, no outside tools. This reads the saved project: after ae_loudness_apply, ae_save and measure again to see the new loudness. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeLoudnessCheckSchema,
      handler: async (args: z.infer<typeof AeLoudnessCheckSchema>, ctx: ToolContext) => {
        const choice: StandardChoice = { standard: args.standard, target_lufs: args.target_lufs, true_peak_max_db: args.true_peak_max_db, tolerance_lu: args.tolerance_lu };
        const wait = args.wait_seconds ?? 30;
        if (args.audio_path !== undefined) {
          if (!path.isAbsolute(args.audio_path) || !fs.existsSync(args.audio_path)) {
            return { ok: false, error: "bad_path", message: `Not an existing absolute path: ${args.audio_path}` };
          }
          try {
            return { ok: true, state: "done", ...(await measureFile(args.audio_path, args.time_offset ?? 0, choice, MAX_ANALYSIS_SECONDS, true)) };
          } catch (err) {
            if (err instanceof AudioDecodeError) return { ok: false, error: "bad_audio", message: err.message };
            throw err;
          }
        }
        if (args.job_id !== undefined) return collect(args.job_id, wait, choice);

        const info = (
          await ctx.bridge.callHost<LoudnessCompInfo>("loudnessRead", { comp_id: args.comp_id, skip_keys: true }, {
            label: "ae_loudness_check (comp)",
            mutates: false,
            toolName: "ae_loudness_check",
            timeoutMs: SLOW_TIMEOUT_MS,
          })
        ).result;
        if (!info.name_unique) {
          return { ok: false, error: "ambiguous_comp", message: `Several comps are named "${info.name}"; aerender picks comps by name. Rename one first.` };
        }
        if (!info.layers.some((l) => l.audio_enabled)) {
          return { ok: false, error: "no_audio", message: `"${info.name}" has no layer with audio switched on.` };
        }
        const start = args.start ?? 0;
        const end = Math.min(args.end ?? info.duration, info.duration);
        if (end <= start) return { ok: false, error: "bad_range", message: `Nothing to render between ${start}s and ${end}s (comp is ${info.duration}s).` };
        // aerender counts frames as AE displays them, from the comp's start frame.
        const firstFrame = Math.round((info.display_start_time ?? 0) * info.fps);
        const startFrame = firstFrame + Math.round(start * info.fps);
        const endFrame = firstFrame + Math.max(Math.round(start * info.fps), Math.ceil(end * info.fps) - 1);
        // The render covers whole frames, which can run a little past end - start: check what is rendered.
        const renderedSeconds = (endFrame - startFrame + 1) / info.fps;
        if (renderedSeconds > MAX_ANALYSIS_SECONDS + 1e-6) {
          return {
            ok: false,
            error: "too_long",
            message: `${Math.round(renderedSeconds)} s of audio; measure at most ${MAX_ANALYSIS_SECONDS / 60} minutes at a time (use start/end)`,
          };
        }
        const dir = path.join(rendersDir(), "audio");
        fs.mkdirSync(dir, { recursive: true });
        pruneOldRenders(dir);
        // The stamp only reaches the second: the random part keeps two renders of the same comp apart.
        const outputPath = path.join(dir, `loudness_${sanitize(info.name)}_${stamp()}_${crypto.randomBytes(3).toString("hex")}.aif`);
        const started = await startRender(
          {
            expect: args.expect,
            comp_name: info.name,
            output_path: outputPath,
            output_module_template: args.output_module_template ?? DEFAULT_AUDIO_TEMPLATE,
            start_frame: startFrame,
            end_frame: endFrame,
          },
          ctx
        );
        if (!started?.job_id) return { ok: false, error: "render_not_started", detail: started };
        // The render begins on a frame boundary: that is the comp time of its first sample.
        const renderStart = Math.round(start * info.fps) / info.fps;
        const meta: LoudnessJobMeta = { comp_id: info.comp_id, comp_name: info.name, offset: renderStart, fps: info.fps, output_path: outputPath };
        jobs.set(started.job_id, meta);
        try {
          fs.writeFileSync(`${outputPath}.json`, JSON.stringify(meta));
        } catch {
          // The in-memory record still serves this session.
        }
        return collect(started.job_id, wait, choice);
      },
    },
    {
      name: "ae_loudness_apply",
      description:
        "Change the level of a comp's audio: add gain_db to the Audio Levels of every layer with audio on (or the layers you name), and optionally fade in and fade out, " +
        "in one undo group guarded by `expect`. Fades are fades of the mix by default (fade_scope 'comp': one ramp over the comp's first fade_in seconds and last fade_out seconds, so a layer that enters or leaves during a fade gets the part of the ramp that falls on it, and a layer outside both fades is left alone); fade_scope 'layer' fades every layer at its own in and out points. " +
        "Existing level keys are all offset by the gain; a key inside a fade region is blended into the fade ramp (so the fade keeps the length asked for), and a fade key at the exact same time as an old key replaces it; a channel at the property's floor stays silent. " +
        "Everything that can fail is checked first: a gain past the Audio Levels maximum, a locked layer, an expression on the levels, fades longer than the comp (fade_scope comp) or than the layer (fade_scope layer), a comp-scope fade that reaches no layer. " +
        "AE has no limiter: pass true_peak_db and true_peak_max_db from ae_loudness_check and a gain that would take the true peak over the ceiling is refused (allow_over_peak to override). " +
        "The read-back (a separate evalScript) checks each layer's static value or key count, and the key values up to 5000 keys per read (500 a layer), and that no other layer's levels moved; the result says when the read-back was capped. It confirms the dB values only: ae_save and ae_loudness_check again to measure the new loudness. " +
        AGENT_SAFETY_GUIDANCE,
      schema: AeLoudnessApplySchema,
      handler: async (args: z.infer<typeof AeLoudnessApplySchema>, ctx: ToolContext) => {
        const gain = args.gain_db ?? 0;
        if (args.true_peak_db !== undefined && args.true_peak_max_db !== undefined && gain > 0 && !args.allow_over_peak) {
          const after = args.true_peak_db + gain;
          if (after > args.true_peak_max_db + 1e-9) {
            const room = Math.max(0, Math.round((args.true_peak_max_db - args.true_peak_db) * 10) / 10);
            return {
              ok: false,
              error: "true_peak_conflict",
              message:
                `+${gain} dB would put the true peak at ${Math.round(after * 10) / 10} dBTP, over the ${args.true_peak_max_db} dBTP ceiling, and AE has no limiter to catch it. ` +
                `The ceiling allows at most +${room} dB. Use a smaller gain, or set allow_over_peak to accept a clipped render.`,
              max_gain_db: room,
            };
          }
        }
        const fades = [args.fade_in ? `in ${args.fade_in}s` : "", args.fade_out ? `out ${args.fade_out}s` : ""].filter(Boolean).join(" ");
        const label = `ae_loudness_apply(${gain >= 0 ? "+" : ""}${gain} dB${fades ? `, fade ${fades}` : ""})`;
        const readCall = () => ({ host: "loudnessRead", args: { comp_id: args.comp_id }, timeoutMs: SLOW_TIMEOUT_MS });
        return runGuardedWrite(ctx, {
          toolName: "ae_loudness_apply",
          label,
          expect: args.expect,
          compId: args.comp_id,
          read: readCall,
          write: {
            host: "loudnessApply",
            timeoutMs: SLOW_TIMEOUT_MS,
            args: {
              comp_id: args.comp_id,
              layers: args.layers,
              gain_db: args.gain_db,
              fade_in: args.fade_in,
              fade_out: args.fade_out,
              fade_scope: args.fade_scope,
              fade_floor_db: args.fade_floor_db,
              label: "Loudness gain and fades",
            },
          },
          check: (before, after, w) => levelsMismatches(before, after, w),
          present: (_before, after, w) => {
            const wrote = (w.layers as WrittenLevels[] | undefined) ?? [];
            const cut = compOf(after)?.layers.some((l) => l.levels?.keys_truncated) === true;
            return {
              gain_db: w.gain_db,
              fade_in: w.fade_in,
              fade_out: w.fade_out,
              fade_floor_db: w.fade_floor_db,
              fade_scope: w.fade_scope,
              skipped: w.skipped,
              layers: wrote.slice(0, 500).map((l) => ({
                index: l.index,
                id: l.id,
                name: l.name,
                mode: l.mode,
                value: l.value,
                keys: l.key_count ?? l.keys.length,
                ...(l.keys_truncated ? { keys_reported: l.keys.length } : {}),
                fade_in: l.fade_in || undefined,
                fade_out: l.fade_out || undefined,
                clamped: l.clamped || undefined,
              })),
              ...(cut ? { readback_keys_truncated: true } : {}),
              next_step: "ae_save, then ae_loudness_check again: the read-back confirms the dB values, not the new loudness.",
            };
          },
        });
      },
    },
  ];
}

export const loudnessTools: ToolDefinition<any>[] = createLoudnessTools();
