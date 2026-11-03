/**
 * server/src/audio.ts
 *
 * Decoding and analysing the audio AE renders, in plain JS (it runs in the
 * panel's Node 17, so no native modules):
 * - decodeAudio: WAV (PCM 8/16/24/32-bit, float, extensible) and AIFF/AIFC
 *   (big-endian PCM, 'sowt', 'fl32', 'fl64') to a mono mix
 * - analyzeAudio: overall level, onsets (spectral flux), tempo
 *   (autocorrelation of the onset envelope with a prior around 120 BPM),
 *   beats (Ellis' dynamic-programming tracker), the strongest hits, and
 *   optional levels per comp frame
 */

export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Channels averaged into one, in -1..1. */
  mono: Float32Array;
  format: string;
}

export class AudioDecodeError extends Error {}

function fourcc(buf: Buffer, at: number): string {
  return buf.toString("latin1", at, at + 4);
}

/** IEEE 754 80-bit extended (AIFF's sample rate). */
export function readExtended80(buf: Buffer, at: number): number {
  const expon = buf.readUInt16BE(at) & 0x7fff;
  const sign = buf[at] & 0x80 ? -1 : 1;
  const hi = buf.readUInt32BE(at + 2);
  const lo = buf.readUInt32BE(at + 6);
  if (expon === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (expon - 16383 - 63);
}

type SampleReader = (buf: Buffer, at: number) => number;

function intReader(bits: number, littleEndian: boolean): SampleReader {
  if (bits === 8) {
    // WAV 8-bit is unsigned; AIFF 8-bit is signed.
    return littleEndian ? (b, at) => (b[at] - 128) / 128 : (b, at) => b.readInt8(at) / 128;
  }
  if (bits === 16) return littleEndian ? (b, at) => b.readInt16LE(at) / 32768 : (b, at) => b.readInt16BE(at) / 32768;
  if (bits === 24) return littleEndian ? (b, at) => b.readIntLE(at, 3) / 8388608 : (b, at) => b.readIntBE(at, 3) / 8388608;
  if (bits === 32) return littleEndian ? (b, at) => b.readInt32LE(at) / 2147483648 : (b, at) => b.readInt32BE(at) / 2147483648;
  throw new AudioDecodeError(`Unsupported PCM bit depth ${bits}`);
}

function floatReader(bits: number, littleEndian: boolean): SampleReader {
  if (bits === 32) return littleEndian ? (b, at) => b.readFloatLE(at) : (b, at) => b.readFloatBE(at);
  if (bits === 64) return littleEndian ? (b, at) => b.readDoubleLE(at) : (b, at) => b.readDoubleBE(at);
  throw new AudioDecodeError(`Unsupported float bit depth ${bits}`);
}

function mixDown(buf: Buffer, start: number, frames: number, channels: number, bytesPerSample: number, read: SampleReader): Float32Array {
  const mono = new Float32Array(frames);
  const block = channels * bytesPerSample;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const at = start + f * block;
    for (let c = 0; c < channels; c++) sum += read(buf, at + c * bytesPerSample);
    mono[f] = sum / channels;
  }
  return mono;
}

function decodeWav(buf: Buffer): DecodedAudio {
  let at = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (at + 8 <= buf.length) {
    const id = fourcc(buf, at);
    let size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the subformat GUID's first two bytes.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") {
      if (!fmt) throw new AudioDecodeError("WAV data chunk before fmt chunk");
      // Streaming writers leave the size at 0 or 0xFFFFFFFF; use what is there.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      const bytes = fmt.bits / 8;
      if (fmt.channels < 1 || !Number.isInteger(bytes) || bytes < 1) throw new AudioDecodeError("Malformed WAV fmt chunk");
      const frames = Math.floor(size / (bytes * fmt.channels));
      let read: SampleReader;
      if (fmt.format === 1) read = intReader(fmt.bits, true);
      else if (fmt.format === 3) read = floatReader(fmt.bits, true);
      else throw new AudioDecodeError(`Unsupported WAV format code ${fmt.format} (PCM and float only)`);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        frames,
        mono: mixDown(buf, body, frames, fmt.channels, bytes, read),
        format: `wav ${fmt.format === 3 ? "float" : "pcm"} ${fmt.bits}-bit`,
      };
    }
    at = body + size + (size % 2);
  }
  throw new AudioDecodeError("WAV file has no data chunk");
}

function decodeAiff(buf: Buffer): DecodedAudio {
  const isAifc = fourcc(buf, 8) === "AIFC";
  let at = 12;
  let comm: { channels: number; frames: number; bits: number; sampleRate: number; compression: string } | null = null;
  while (at + 8 <= buf.length) {
    const id = fourcc(buf, at);
    let size = buf.readUInt32BE(at + 4);
    const body = at + 8;
    if (id === "COMM") {
      comm = {
        channels: buf.readInt16BE(body),
        frames: buf.readUInt32BE(body + 2),
        bits: buf.readInt16BE(body + 6),
        sampleRate: readExtended80(buf, body + 8),
        compression: isAifc && size >= 22 ? fourcc(buf, body + 18) : "NONE",
      };
    } else if (id === "SSND") {
      if (!comm) throw new AudioDecodeError("AIFF SSND chunk before COMM chunk");
      if (body + size > buf.length) size = buf.length - body;
      const offset = buf.readUInt32BE(body);
      const start = body + 8 + offset;
      const c = comm.compression;
      let read: SampleReader;
      let bits = comm.bits;
      if (c === "NONE" || c === "twos") read = intReader(bits, false);
      else if (c === "sowt") read = intReader(bits, true);
      else if (c === "fl32" || c === "FL32") {
        bits = 32;
        read = floatReader(32, false);
      } else if (c === "fl64" || c === "FL64") {
        bits = 64;
        read = floatReader(64, false);
      } else throw new AudioDecodeError(`Unsupported AIFC compression '${c}'`);
      const bytes = Math.ceil(bits / 8);
      const available = Math.floor((body + size - start) / (bytes * comm.channels));
      const frames = Math.max(0, Math.min(comm.frames, available));
      return {
        sampleRate: comm.sampleRate,
        channels: comm.channels,
        frames,
        mono: mixDown(buf, start, frames, comm.channels, bytes, read),
        format: `${isAifc ? "aifc" : "aiff"} ${c} ${bits}-bit`,
      };
    }
    at = body + size + (size % 2);
  }
  throw new AudioDecodeError("AIFF file has no SSND chunk");
}

export function decodeAudio(buf: Buffer): DecodedAudio {
  if (buf.length < 12) throw new AudioDecodeError("File too short to be audio");
  const head = fourcc(buf, 0);
  const kind = fourcc(buf, 8);
  if (head === "RIFF" && kind === "WAVE") return decodeWav(buf);
  if (head === "FORM" && (kind === "AIFF" || kind === "AIFC")) return decodeAiff(buf);
  throw new AudioDecodeError("Not a WAV or AIFF file");
}

// ---------- analysis ----------

export interface Onset {
  time: number;
  /** 0..1: how sudden the change is, relative to the most sudden onset in the file. */
  strength: number;
  /** Peak level in dBFS over the 50 ms after the onset: how loud the hit is. */
  level_db: number;
}

export interface AudioAnalysis {
  duration: number;
  sample_rate: number;
  overall: { peak_db: number; rms_db: number; silent_ratio: number };
  onsets: Onset[];
  tempo: { bpm: number; period: number; confidence: number; beats_on_onsets: number } | null;
  beats: number[];
  hits: Onset[];
  levels?: { step: number; rms_db: number[]; peak_db: number[] };
}

export interface AnalyzeOptions {
  /** Frame rate for the levels (the comp's). */
  fps?: number;
  levels?: boolean;
  min_bpm?: number;
  max_bpm?: number;
  /** 0..1; higher finds quieter onsets. Default 0.5. */
  sensitivity?: number;
  hits?: number;
}

const SILENCE_DB = -50;
const MAX_LEVEL_POINTS = 500;

export const toDb = (x: number): number => Math.round(20 * Math.log10(Math.max(x, 1e-10)) * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Spectral flux: the summed rise in log magnitude between frames, frame t
 * centred on sample t * hop.
 */
export function onsetEnvelope(mono: Float32Array, sampleRate: number): { env: Float64Array; hop: number; frameRate: number } {
  const n = sampleRate > 60000 ? 2048 : 1024;
  const hop = n / 2;
  const frames = Math.max(1, Math.floor(mono.length / hop) + 1);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const bins = n / 2;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const env = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    const start = t * hop - n / 2;
    for (let i = 0; i < n; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < mono.length ? mono[s] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (t > 0) {
        const d = cur[k] - prev[k];
        if (d > 0) flux += d;
      }
    }
    env[t] = flux;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return { env, hop, frameRate: sampleRate / hop };
}

/** Peaks above a local average, at least `wait` frames apart (librosa's picker). */
export function pickPeaks(env: Float64Array, frameRate: number, delta: number): number[] {
  const peaks: number[] = [];
  const preMax = Math.max(1, Math.round(0.03 * frameRate));
  const postMax = 1;
  const avg = Math.max(1, Math.round(0.1 * frameRate));
  const wait = Math.max(1, Math.round(0.05 * frameRate));
  let last = -Infinity;
  for (let t = 0; t < env.length; t++) {
    const v = env[t];
    if (v <= 0) continue;
    let isMax = true;
    for (let k = Math.max(0, t - preMax); k <= Math.min(env.length - 1, t + postMax); k++) {
      if (env[k] > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, t - avg); k <= Math.min(env.length - 1, t + avg); k++) {
      sum += env[k];
      count++;
    }
    if (v < sum / count + delta) continue;
    if (t - last < wait) continue;
    peaks.push(t);
    last = t;
  }
  return peaks;
}

/** The tempo period in frames: autocorrelation weighted by a log-normal prior at 120 BPM. */
export function estimatePeriod(env: Float64Array, frameRate: number, minBpm: number, maxBpm: number): { period: number; confidence: number } | null {
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const x = Array.from(env, (v) => v - mean);
  const minLag = Math.max(1, Math.floor((60 * frameRate) / maxBpm));
  const maxLag = Math.min(x.length - 1, Math.ceil((60 * frameRate) / minBpm));
  if (maxLag <= minLag + 1) return null;
  let r0 = 0;
  for (const v of x) r0 += v * v;
  if (r0 <= 0) return null;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    if (lag < 1) continue;
    let s = 0;
    for (let t = 0; t + lag < x.length; t++) s += x[t] * x[t + lag];
    r[lag] = s;
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const score = r[lag] * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || r[best] <= 0) return null;
  // Parabolic interpolation for a fractional lag.
  const a = r[best - 1];
  const b = r[best];
  const c = r[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return { period: best + shift, confidence: Math.max(0, Math.min(1, b / r0)) };
}

/** Ellis (2007) dynamic-programming beat tracker on the onset envelope. */
export function trackBeats(env: Float64Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (n === 0 || period <= 1) return [];
  // Smooth the envelope with a small Gaussian (sigma = period / 16).
  const sigma = Math.max(1, period / 16);
  const radius = Math.ceil(3 * sigma);
  const local = new Float64Array(n);
  const max = env.reduce((m, v) => Math.max(m, v), 0) || 1;
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const i = t + k;
      if (i >= 0 && i < n) s += (env[i] / max) * Math.exp(-0.5 * (k / sigma) ** 2);
    }
    local[t] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (v > best) {
        best = v;
        arg = p;
      }
    }
    score[t] = local[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // End on the best score within the last two periods.
  let end = n - 1;
  for (let t = Math.max(0, n - hi); t < n; t++) if (score[t] > score[end]) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
}

export function analyzeAudio(mono: Float32Array, sampleRate: number, opts: AnalyzeOptions = {}): AudioAnalysis {
  const duration = mono.length / sampleRate;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < mono.length; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
    sumSq += mono[i] * mono[i];
  }
  const rms = mono.length ? Math.sqrt(sumSq / mono.length) : 0;

  // Levels per comp frame, and the share of silent frames.
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 25;
  const frameLen = Math.max(1, Math.round(sampleRate / fps));
  const frameCount = Math.max(1, Math.ceil(mono.length / frameLen));
  const frameRms = new Float64Array(frameCount);
  const framePeak = new Float64Array(frameCount);
  let silent = 0;
  for (let f = 0; f < frameCount; f++) {
    let s = 0;
    let p = 0;
    const end = Math.min(mono.length, (f + 1) * frameLen);
    let count = 0;
    for (let i = f * frameLen; i < end; i++) {
      s += mono[i] * mono[i];
      const a = Math.abs(mono[i]);
      if (a > p) p = a;
      count++;
    }
    frameRms[f] = count ? Math.sqrt(s / count) : 0;
    framePeak[f] = p;
    if (toDb(frameRms[f]) < SILENCE_DB) silent++;
  }

  const { env, hop, frameRate } = onsetEnvelope(mono, sampleRate);
  const envMax = env.reduce((m, v) => Math.max(m, v), 0);
  const norm = Float64Array.from(env, (v) => (envMax > 0 ? v / envMax : 0));
  const sensitivity = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5));
  const delta = 0.02 + (1 - sensitivity) * 0.16;
  const peakFrames = envMax > 0 ? pickPeaks(norm, frameRate, delta) : [];
  const hitWindow = Math.round(0.05 * sampleRate);
  const onsets: Onset[] = peakFrames.map((t) => {
    const at = t * hop;
    let p = 0;
    for (let i = Math.max(0, at - hop); i < Math.min(mono.length, at + hitWindow); i++) p = Math.max(p, Math.abs(mono[i]));
    return { time: round3(at / sampleRate), strength: round3(norm[t]), level_db: toDb(p) };
  });

  let tempo: AudioAnalysis["tempo"] = null;
  let beats: number[] = [];
  const est = onsets.length >= 4 ? estimatePeriod(norm, frameRate, opts.min_bpm ?? 60, opts.max_bpm ?? 200) : null;
  if (est) {
    const first = onsets[0].time;
    const last = onsets[onsets.length - 1].time;
    const periodSec = est.period / frameRate;
    // Beats only where there is sound: from half a period before the first onset to half after the last.
    beats = trackBeats(norm, est.period)
      .map((t) => (t * hop) / sampleRate)
      .filter((t) => t >= first - periodSec / 2 && t <= last + periodSec / 2)
      .map(round3);
    const near = beats.filter((b) => onsets.some((o) => Math.abs(o.time - b) <= 0.07)).length;
    tempo = {
      bpm: Math.round((60 / periodSec) * 10) / 10,
      period: round3(periodSec),
      confidence: round3(est.confidence),
      beats_on_onsets: beats.length ? round3(near / beats.length) : 0,
    };
  }

  // The loudest hits first; equally loud ones by how sudden they are.
  const hits = [...onsets].sort((a, b) => b.level_db - a.level_db || b.strength - a.strength).slice(0, opts.hits ?? 20);
  const out: AudioAnalysis = {
    duration: round3(duration),
    sample_rate: sampleRate,
    overall: { peak_db: toDb(peak), rms_db: toDb(rms), silent_ratio: round3(silent / frameCount) },
    onsets,
    tempo,
    beats,
    hits,
  };
  if (opts.levels) {
    // Max-pool down to at most 500 points so long comps stay bounded.
    const bucket = Math.max(1, Math.ceil(frameCount / MAX_LEVEL_POINTS));
    const rmsDb: number[] = [];
    const peakDb: number[] = [];
    for (let i = 0; i < frameCount; i += bucket) {
      let r = 0;
      let p = 0;
      for (let k = i; k < Math.min(frameCount, i + bucket); k++) {
        r = Math.max(r, frameRms[k]);
        p = Math.max(p, framePeak[k]);
      }
      rmsDb.push(toDb(r));
      peakDb.push(toDb(p));
    }
    out.levels = { step: round3((bucket * frameLen) / sampleRate), rms_db: rmsDb, peak_db: peakDb };
  }
  return out;
}

/** Shifts every time in an analysis by `offset` seconds (file time to comp time). */
export function offsetAnalysis(a: AudioAnalysis, offset: number): AudioAnalysis {
  if (!offset) return a;
  const sh = (t: number) => round3(t + offset);
  return {
    ...a,
    onsets: a.onsets.map((o) => ({ ...o, time: sh(o.time) })),
    beats: a.beats.map(sh),
    hits: a.hits.map((o) => ({ ...o, time: sh(o.time) })),
  };
}
