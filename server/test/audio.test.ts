import { describe, expect, it } from "vitest";
import { analyzeAudio, AudioDecodeError, decodeAudio, offsetAnalysis, readExtended80 } from "../src/audio.js";
import { planCueKeys } from "../src/tools/ext/audio.js";

// ---------- encoders for fixtures ----------

function wav(samples: number[][], sampleRate: number, bits: 16 | 24 | 32, float = false): Buffer {
  const channels = samples.length;
  const frames = samples[0].length;
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = samples[c][f];
      const at = (f * channels + c) * bytes;
      if (float) data.writeFloatLE(v, at);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), at);
    }
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(float ? 3 : 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bits, 22);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  const dh = Buffer.alloc(8);
  dh.write("data", 0, "latin1");
  dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dh, data]);
}

/** IEEE 754 80-bit extended for an integer sample rate. */
function extended80(n: number): Buffer {
  const b = Buffer.alloc(10);
  const e = Math.floor(Math.log2(n));
  b.writeUInt16BE(16383 + e, 0);
  const mant = BigInt(n) << BigInt(63 - e);
  b.writeBigUInt64BE(mant, 2);
  return b;
}

function aiff(samples: number[][], sampleRate: number, compression?: "sowt"): Buffer {
  const channels = samples.length;
  const frames = samples[0].length;
  const data = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.round(samples[c][f] * 32767);
      if (compression === "sowt") data.writeInt16LE(v, (f * channels + c) * 2);
      else data.writeInt16BE(v, (f * channels + c) * 2);
    }
  }
  const commBody = Buffer.alloc(compression ? 24 : 18);
  commBody.writeInt16BE(channels, 0);
  commBody.writeUInt32BE(frames, 2);
  commBody.writeInt16BE(16, 6);
  extended80(sampleRate).copy(commBody, 8);
  if (compression) {
    commBody.write(compression, 18, "latin1");
    commBody.writeUInt8(0, 22); // empty pascal-string name, padded
  }
  const comm = Buffer.concat([Buffer.from("COMM", "latin1"), Buffer.alloc(4), commBody]);
  comm.writeUInt32BE(commBody.length, 4);
  const ssndHead = Buffer.alloc(16);
  ssndHead.write("SSND", 0, "latin1");
  ssndHead.writeUInt32BE(8 + data.length, 4);
  const form = Buffer.alloc(12);
  form.write("FORM", 0, "latin1");
  form.writeUInt32BE(4 + comm.length + ssndHead.length + data.length, 4);
  form.write(compression ? "AIFC" : "AIFF", 8, "latin1");
  return Buffer.concat([form, comm, ssndHead, data]);
}

/** Deterministic noise. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/** Decaying noise bursts at `times`, with a little background hiss. */
function clickTrack(times: number[], seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const rnd = lcg(7);
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.002;
  for (const t of times) {
    const start = Math.round(t * sampleRate);
    for (let i = 0; i < 0.03 * sampleRate && start + i < out.length; i++) {
      out[start + i] += rnd() * 0.8 * Math.exp(-i / (0.006 * sampleRate));
    }
  }
  return out;
}

// ---------- decoding ----------

describe("decodeAudio", () => {
  const left = [0, 0.5, -0.5, 0.25];
  const right = [0, 0.5, 0.5, -0.25];

  it("reads 16-bit stereo WAV as a mono mix", () => {
    const d = decodeAudio(wav([left, right], 48000, 16));
    expect(d).toMatchObject({ sampleRate: 48000, channels: 2, frames: 4 });
    expect(Array.from(d.mono).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, 0, 0]);
  });

  it("reads 24-bit and float WAV", () => {
    expect(decodeAudio(wav([left], 44100, 24)).mono[1]).toBeCloseTo(0.5, 4);
    expect(decodeAudio(wav([left], 44100, 32, true)).mono[2]).toBeCloseTo(-0.5, 6);
  });

  it("reads AIFF with its 80-bit sample rate, and AIFC 'sowt'", () => {
    const a = decodeAudio(aiff([left, right], 48000));
    expect(a).toMatchObject({ sampleRate: 48000, channels: 2, frames: 4 });
    expect(a.mono[1]).toBeCloseTo(0.5, 3);
    const s = decodeAudio(aiff([left], 44100, "sowt"));
    expect(s.sampleRate).toBe(44100);
    expect(s.mono[2]).toBeCloseTo(-0.5, 3);
    expect(s.format).toMatch(/aifc sowt/);
  });

  it("decodes 80-bit extended numbers", () => {
    expect(readExtended80(extended80(44100), 0)).toBe(44100);
    expect(readExtended80(extended80(96000), 0)).toBe(96000);
  });

  it("refuses other files", () => {
    expect(() => decodeAudio(Buffer.from("ID3\u0003 not audio at all"))).toThrow(AudioDecodeError);
  });
});

// ---------- analysis ----------

describe("analyzeAudio", () => {
  const sr = 44100;
  const clicks = Array.from({ length: 16 }, (_, i) => 0.25 + i * 0.5); // 120 BPM

  it("finds 120 BPM, the onsets and the beats of a click track", async () => {
    const a = await analyzeAudio(clickTrack(clicks, 8.5, sr), sr, { fps: 25 });
    expect(a.tempo?.bpm).toBeGreaterThan(118);
    expect(a.tempo?.bpm).toBeLessThan(122);
    expect(a.onsets.length).toBe(clicks.length);
    for (const c of clicks) expect(a.onsets.some((o) => Math.abs(o.time - c) < 0.02)).toBe(true);
    const onClick = a.beats.filter((b) => clicks.some((c) => Math.abs(b - c) < 0.03)).length;
    expect(onClick / a.beats.length).toBeGreaterThan(0.9);
    expect(a.tempo?.beats_on_onsets).toBeGreaterThan(0.9);
    expect(a.hits.length).toBeLessThanOrEqual(20);
  });

  it("prefers the tapped tempo over its half when hits fall on every other beat too", async () => {
    // Accents every beat at 100 BPM.
    const beats = Array.from({ length: 14 }, (_, i) => 0.3 + i * 0.6);
    const a = await analyzeAudio(clickTrack(beats, 9, sr), sr);
    expect(Math.abs((a.tempo?.bpm ?? 0) - 100)).toBeLessThan(3);
  });

  it("reads a kick on the beat with quieter hats between as 120, not 240", async () => {
    const kicks = clickTrack(clicks, 8.5, sr);
    const hats = clickTrack(clicks.map((c) => c + 0.25), 8.5, sr);
    const mix = Float32Array.from(kicks, (v, i) => v + 0.4 * hats[i]);
    const a = await analyzeAudio(mix, sr);
    expect(Math.abs((a.tempo?.bpm ?? 0) - 120)).toBeLessThan(2);
    // Every hit is still an onset; the kicks are the strongest.
    expect(a.onsets.length).toBeGreaterThanOrEqual(30);
    expect(a.hits.slice(0, 10).every((h) => clicks.some((c) => Math.abs(h.time - c) < 0.02))).toBe(true);
  });

  it("reports silence as silence", async () => {
    const a = await analyzeAudio(new Float32Array(sr * 2), sr);
    expect(a.onsets).toEqual([]);
    expect(a.tempo).toBeNull();
    expect(a.beats).toEqual([]);
    expect(a.overall.silent_ratio).toBe(1);
  });

  it("keeps levels to at most 500 points", async () => {
    const a = await analyzeAudio(clickTrack(clicks, 30, 22050), 22050, { fps: 30, levels: true });
    expect(a.levels!.rms_db.length).toBeLessThanOrEqual(500);
    expect(a.levels!.step).toBeCloseTo(2 / 30, 5);
    expect(Math.max(...a.levels!.peak_db)).toBeGreaterThan(-6);
  });

  it("shifts every time by an offset", async () => {
    const a = await analyzeAudio(clickTrack(clicks.slice(0, 6), 3.5, sr), sr);
    const b = offsetAnalysis(a, 10);
    expect(b.onsets[0].time).toBeCloseTo(a.onsets[0].time + 10, 3);
    expect(b.hits[0].time).toBeCloseTo(a.hits[0].time + 10, 3);
  });
});

// ---------- cue keys ----------

describe("planCueKeys", () => {
  const frame = 1 / 25;

  it("jumps one frame before each cue and settles after the decay", () => {
    const keys = planCueKeys([1, 2], { attack: 0, decay: 0.2, frame, peak: 120 });
    expect(keys.map((k) => [k.kind, k.time, k.value])).toEqual([
      ["pre", 0.96, null],
      ["peak", 1, 120],
      ["post", 1.2, null],
      ["pre", 1.96, null],
      ["peak", 2, 120],
      ["post", 2.2, null],
    ]);
  });

  it("chains close cues peak to peak, and uses a given base", () => {
    const keys = planCueKeys([1, 1.1], { attack: 0, decay: 0.3, frame, peak: [110, 110], base: [100, 100] });
    expect(keys.map((k) => k.kind)).toEqual(["pre", "peak", "pre", "peak", "post"]);
    expect(keys[0].value).toEqual([100, 100]);
  });

  it("drops a cue within half a frame of the previous one, and a pre key before time 0", () => {
    const keys = planCueKeys([0, 0.01, 1], { attack: 0, decay: 0.1, frame, peak: 1 });
    expect(keys.filter((k) => k.kind === "peak").map((k) => k.time)).toEqual([0, 1]);
    expect(keys[0].kind).toBe("peak");
  });
});
