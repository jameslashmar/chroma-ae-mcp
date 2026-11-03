import { describe, expect, it } from "vitest";
import { detectFormat, parseTimecode, parseTranscript, segmentWords, transcriptCues, TranscriptError } from "../src/transcript.js";

const SRT = `1
00:00:01,000 --> 00:00:02,500
ANNA: Hello there.

2
00:00:03,000 --> 00:00:05,000
BEN: Hi! How are you?
`;

const VTT = `WEBVTT

intro
00:01.000 --> 00:02.000 align:start
<v Anna>Welcome back.</v>

00:00:02.500 --> 00:00:04.000
Second line
`;

const ELEVEN = JSON.stringify({
  language_code: "en",
  text: "Hello world. Next.",
  words: [
    { text: "Hello", start: 0.1, end: 0.4, type: "word", speaker_id: "speaker_0" },
    { text: " ", start: 0.4, end: 0.5, type: "spacing", speaker_id: "speaker_0" },
    { text: "world.", start: 0.5, end: 0.9, type: "word", speaker_id: "speaker_0" },
    { text: "(laughs)", start: 1.0, end: 1.4, type: "audio_event" },
    { text: "Next.", start: 2.5, end: 2.9, type: "word", speaker_id: "speaker_1" },
  ],
});

describe("parseTimecode", () => {
  it("reads SRT, VTT and plain seconds", () => {
    expect(parseTimecode("01:02:03,456")).toBeCloseTo(3723.456, 6);
    expect(parseTimecode("02:03.5")).toBeCloseTo(123.5, 6);
    expect(parseTimecode("12.25")).toBe(12.25);
    expect(() => parseTimecode("1:xx")).toThrow(TranscriptError);
  });
});

describe("parseTranscript", () => {
  it("reads SRT with speaker prefixes", () => {
    const s = parseTranscript(SRT);
    expect(s).toEqual([
      { text: "Hello there.", start: 1, end: 2.5, speaker: "ANNA" },
      { text: "Hi! How are you?", start: 3, end: 5, speaker: "BEN" },
    ]);
  });

  it("reads WebVTT with cue ids, settings and voice spans", () => {
    const s = parseTranscript(VTT);
    expect(s[0]).toEqual({ text: "Welcome back.", start: 1, end: 2, speaker: "Anna" });
    expect(s[1]).toMatchObject({ text: "Second line", start: 2.5, end: 4 });
  });

  it("reads ElevenLabs words, skipping spacing and sound events, split by speaker", () => {
    const s = parseTranscript(ELEVEN);
    expect(s.map((x) => [x.text, x.speaker])).toEqual([
      ["Hello world.", "speaker_0"],
      ["Next.", "speaker_1"],
    ]);
    expect(s[0].words?.length).toBe(2);
  });

  it("reads Whisper segments and plain arrays", () => {
    const whisper = JSON.stringify({ segments: [{ start: 0, end: 2, text: " One two.", words: [{ word: "One", start: 0, end: 0.8 }, { word: "two.", start: 1, end: 2 }] }] });
    expect(parseTranscript(whisper)[0]).toMatchObject({ text: "One two.", start: 0, end: 2 });
    expect(parseTranscript(JSON.stringify([{ text: "A", start: 1, end: 2 }]))).toEqual([{ text: "A", start: 1, end: 2 }]);
  });

  it("detects the format and refuses an empty transcript", () => {
    expect(detectFormat(VTT)).toBe("vtt");
    expect(detectFormat("{}")).toBe("json");
    expect(detectFormat("x", "C:/a/b.SRT")).toBe("srt");
    expect(() => parseTranscript("no cues here")).toThrow(TranscriptError);
  });
});

describe("segmentWords", () => {
  it("splits at a pause longer than the gap", () => {
    const s = segmentWords([
      { text: "a", start: 0, end: 0.2 },
      { text: "b", start: 0.3, end: 0.5 },
      { text: "c", start: 2, end: 2.2 },
    ]);
    expect(s.map((x) => x.text)).toEqual(["a b", "c"]);
  });
});

describe("transcriptCues", () => {
  it("makes one cue per segment with a label per speaker and an offset", () => {
    const cues = transcriptCues(parseTranscript(SRT), { offset: 10 });
    expect(cues).toEqual([
      { time: 11, duration: 1.5, comment: "Hello there.", speaker: "ANNA", label: 1 },
      { time: 13, duration: 2, comment: "Hi! How are you?", speaker: "BEN", label: 2 },
    ]);
  });

  it("splits into sentences, by character share without word timings", () => {
    const cues = transcriptCues(parseTranscript(SRT), { unit: "sentence", speaker_labels: false });
    expect(cues.map((c) => c.comment)).toEqual(["Hello there.", "Hi!", "How are you?"]);
    expect(cues[1].time).toBe(3);
    expect(cues[2].time).toBeGreaterThan(3);
    expect(cues.every((c) => c.label === undefined)).toBe(true);
  });

  it("makes one cue per word from word timings", () => {
    const cues = transcriptCues(parseTranscript(ELEVEN), { unit: "word" });
    expect(cues.map((c) => [c.comment, c.time, c.label])).toEqual([
      ["Hello", 0.1, 1],
      ["world.", 0.5, 1],
      ["Next.", 2.5, 2],
    ]);
  });
});
