import { describe, expect, it } from "vitest";
import { breakPenalty, CAPTION_STANDARD_IDS, CAPTION_STANDARDS, SPEAKER_COLORS, weakEndReason } from "../src/caption-standards.js";
import { Rec, splitPass, type RuleSettings, type WorkCap } from "../src/caption-rules.js";
import { breakLines, buildCaptions, parseTranscript, transcriptCues, type CaptionOptions, type TranscriptWord } from "../src/transcript.js";

type Spec = [text: string, start: number, end: number, speaker?: string];
const W = (spec: Spec[]): TranscriptWord[] => spec.map(([text, start, end, speaker]) => ({ text, start, end, ...(speaker ? { speaker } : {}) }));
const plan = (words: TranscriptWord[], opts: CaptionOptions = {}) => buildCaptions([{ text: "x", start: words[0].start, end: words[words.length - 1].end, words }], opts);
/** Words one after another, `step` apart, `dur` long. */
const run = (texts: string[], opts: { start?: number; step?: number; dur?: number; speaker?: string } = {}): TranscriptWord[] =>
  texts.map((text, i) => ({
    text,
    start: (opts.start ?? 0) + i * (opts.step ?? 0.5),
    end: (opts.start ?? 0) + i * (opts.step ?? 0.5) + (opts.dur ?? 0.4),
    ...(opts.speaker ? { speaker: opts.speaker } : {}),
  }));
const text = (c: { lines: string[] }) => c.lines.join(" ");
const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);
const f24 = (n: number) => n / 24;

describe("output contract", () => {
  it("with no new options: changes and violations are empty, show_at is set, kind is speech", () => {
    const p = plan(run(["Hello", "there", "friends."]), { frame_rate: 25 });
    expect(p.changes).toEqual([]);
    expect(p.violations).toEqual([]);
    expect(p.standard).toBeUndefined();
    expect(p.cleanup).toBeUndefined();
    expect(p.captions[0].kind).toBe("speech");
    for (const w of p.captions[0].words) expect(w.show_at).toBeDefined();
    // Same timing as the old planner: last word ends 1.4 + 0.25 linger = 1.65, snapped to 25 fps.
    near(p.captions[0].end, 1.64);
  });
});

describe("standards", () => {
  it("every standard sets line length, lines and durations, and names itself in the plan", () => {
    const words = run("the quick brown fox jumps over the lazy dog while the band plays on and on through the night".split(" "), { step: 0.3, dur: 0.25 });
    for (const id of CAPTION_STANDARD_IDS) {
      const std = CAPTION_STANDARDS[id];
      const p = plan(words, { standard: id, frame_rate: 24 });
      expect(p.standard).toBe(id);
      for (const c of p.captions) {
        expect(c.lines.length).toBeLessThanOrEqual(std.max_lines);
        for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(std.max_cpl);
        expect(c.end - c.start).toBeLessThanOrEqual(std.max_duration_s + 1e-6);
      }
    }
  });

  it("explicit fields beat the standard", () => {
    const words = run("one two three four five six seven eight nine ten eleven twelve".split(" "), { step: 0.3, dur: 0.25 });
    const p = plan(words, { standard: "netflix_adult", max_chars_per_line: 12, max_lines: 1, frame_rate: 24 });
    for (const c of p.captions) {
      expect(c.lines).toHaveLength(1);
      expect(c.lines[0].length).toBeLessThanOrEqual(12);
    }
  });

  it("assumes 24 fps without a frame rate and says so", () => {
    const p = plan(run(["Hello", "there."]), { standard: "netflix_adult" });
    expect(p.warnings.join(" ")).toMatch(/24 fps/);
    expect(plan(run(["Hello", "there."]), { standard: "netflix_adult", frame_rate: 25 }).warnings.join(" ")).not.toMatch(/24 fps/);
    expect(plan(run(["Hello", "there."])).warnings.join(" ")).not.toMatch(/24 fps/);
  });

  it("holds a short caption to the standard's minimum and lingers toward 0.5 s", () => {
    const p = plan(W([["Hi.", 1, 1.2], ["Later", 6, 6.4]]), { standard: "netflix_adult", frame_rate: 24 });
    // 0.2 s of speech: the 5/6 s minimum (20 frames) wins over 0.2 + 0.5.
    near(p.captions[0].end - p.captions[0].start, 20 / 24);
    const longer = plan(W([["Hello", 1, 1.6], ["Later", 6, 6.4]]), { standard: "netflix_adult", frame_rate: 24 });
    // 1.6 + 0.5 linger = 2.1 s.
    near(longer.captions[0].end, 2.1, 0.03);
    expect(longer.violations).toEqual([]);
  });
});

describe("fixing: extend, merge, split", () => {
  it("extends an out-time into the gap for reading speed and records it", () => {
    // 40 characters over 0.5 s of speech: 20 cps needs 2 s on screen.
    const p = plan(W([["Extraordinarily", 0, 0.3], ["unbelievable", 0.3, 0.5], ["circumstances", 0.5, 0.7], ["Later", 9, 9.5]]), { standard: "netflix_adult", frame_rate: 24, pause_break: 3 });
    const c = p.captions[0];
    expect(c.end - c.start).toBeGreaterThanOrEqual(text(c).length / 20 - 1e-6);
    expect(p.violations).toEqual([]);
    const ch = p.changes.find((x) => x.n === 1 && x.action === "extended");
    expect(ch).toBeDefined();
    expect(["cps", "min_duration"]).toContain(ch!.rule);
  });

  it("never extends into the next caption or the minimum gap", () => {
    const p = plan(W([["Extraordinarily", 0, 0.3], ["unbelievable", 0.3, 0.5], ["circumstances", 0.5, 0.7], ["Later", 1.3, 1.6]]), { standard: "netflix_adult", frame_rate: 24, pause_break: 0.3, fix: true });
    for (let i = 0; i + 1 < p.captions.length; i++) {
      expect(p.captions[i + 1].start - p.captions[i].end).toBeGreaterThanOrEqual(f24(2) - 1e-6);
    }
  });

  it("merges a too-short caption with its neighbour when the result fits, and lists it", () => {
    const words = W([["Yes.", 0, 0.3], ["No.", 0.6, 0.9]]);
    const p = plan(words, { standard: "netflix_adult", frame_rate: 24, pause_break: 0.2 });
    expect(p.captions).toHaveLength(1);
    expect(text(p.captions[0])).toBe("Yes. No.");
    const merge = p.changes.find((c) => c.action === "merged");
    expect(merge).toMatchObject({ n: 1, rule: "min_duration" });
    expect(p.violations).toEqual([]);
  });

  it("does not merge across a speaker change", () => {
    const words = W([["Yes.", 0, 0.3, "A"], ["No.", 0.6, 0.9, "B"]]);
    const p = plan(words, { standard: "netflix_adult", frame_rate: 24, pause_break: 0.2 });
    expect(p.captions).toHaveLength(2);
    expect(p.violations.some((v) => v.rule === "min_duration")).toBe(true);
  });

  it("with fix: false it reports violations and changes nothing extra", () => {
    const words = W([["Yes.", 0, 0.3], ["No.", 0.6, 0.9]]);
    const p = plan(words, { standard: "netflix_adult", frame_rate: 24, pause_break: 0.2, fix: false });
    expect(p.captions).toHaveLength(2);
    expect(p.changes).toEqual([]);
    expect(p.violations.map((v) => [v.n, v.rule])).toContainEqual([1, "min_duration"]);
    // Reading speed is reported too.
    const fast = plan(W([["Extraordinarily", 0, 0.3], ["unbelievable", 0.3, 0.5], ["circumstances", 0.5, 0.7], ["Later", 1.0, 1.5]]), { standard: "netflix_adult", frame_rate: 24, pause_break: 0.2, fix: false });
    expect(fast.violations.some((v) => v.rule === "cps")).toBe(true);
  });

  it("leaves a rule that cannot be fixed in violations", () => {
    // Fast speech with no room: the next caption starts right after, and the speakers differ.
    const p = plan(W([["Extraordinarily", 0, 0.3, "A"], ["unbelievable", 0.3, 0.5, "A"], ["circumstances", 0.5, 0.7, "A"], ["Later", 0.9, 1.5, "B"]]), { standard: "netflix_adult", frame_rate: 24 });
    expect(p.violations.some((v) => v.rule === "cps" && v.n === 1)).toBe(true);
  });

  it("splitPass splits an over-long caption at the best grammatical point near the middle", () => {
    const words = run("We went to the shop and then we came home again".split(" "), { step: 1, dur: 0.9 }).map((w) => ({ ...w }));
    const S: RuleSettings = {
      frame: 1 / 24,
      snap: (t) => Math.round(t * 24) / 24,
      maxChars: 60,
      maxLines: 2,
      minDur: 0.8,
      maxDur: 6,
      linger: 0.5,
      minGapT: 2 / 24,
      closeUnder: 0,
      cutZone: 0.5,
      cuts: [],
      std: CAPTION_STANDARDS.netflix_adult,
      fix: true,
      singleWord: false,
      layout: (c) => breakLines(c.words.map((w) => w.text), 60),
    };
    const cap: WorkCap = {
      start: 0,
      end: 12,
      lines: [words.map((w) => w.text).join(" ")],
      words: words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
      kind: "speech",
      gram: words.map((w) => w.text),
      spk: words.map(() => undefined),
      rawStart: 0,
      rawLastEnd: 11.9,
    };
    const caps = [cap];
    const rec = new Rec();
    splitPass(caps, S, rec);
    expect(caps.length).toBeGreaterThan(1);
    expect(caps.flatMap((c) => c.words.map((w) => w.text))).toEqual(words.map((w) => w.text));
    for (const c of caps) expect(c.words[c.words.length - 1].end - c.words[0].start).toBeLessThanOrEqual(6);
    // Never ends a part on a weak word.
    for (const c of caps.slice(0, -1)) expect(["the", "to", "and", "we"]).not.toContain(c.words[c.words.length - 1].text);
    expect(rec.items[0]).toMatchObject({ rule: "max_duration", action: "split" });
  });
});

describe("gaps and linger", () => {
  const gapPlan = (gapFrames: number, fps: number, extra: CaptionOptions = {}) => {
    const a = [{ text: "one", start: 0, end: 0.5 }];
    const b = [{ text: "two", start: 0.5 + gapFrames / fps, end: 1.0 + gapFrames / fps }];
    return buildCaptions([{ text: "x", start: 0, end: 2, words: [...a, ...b] }], { frame_rate: fps, linger: 0, min_duration: 0.1, pause_break: 0.03, min_gap_frames: 2, close_gaps_under: 0.5, ...extra });
  };

  it("closes gaps of 3 to 11 frames at 24 fps to 2 frames, leaves 12 or more", () => {
    for (let g = 3; g <= 11; g++) {
      const p = gapPlan(g, 24);
      expect(p.captions).toHaveLength(2);
      near(p.captions[1].start - p.captions[0].end, 2 / 24);
      expect(p.changes.some((c) => c.rule === "close_gap" && c.n === 1)).toBe(true);
    }
    for (const g of [12, 20]) {
      const p = gapPlan(g, 24);
      near(p.captions[1].start - p.captions[0].end, g / 24);
      expect(p.changes.some((c) => c.rule === "close_gap")).toBe(false);
    }
  });

  it("scales the closing threshold to the frame rate (0.5 s is 15 frames at 30 fps)", () => {
    near(gapPlan(14, 30).captions[1].start - gapPlan(14, 30).captions[0].end, 2 / 30);
    near(gapPlan(15, 30).captions[1].start - gapPlan(15, 30).captions[0].end, 15 / 30);
    near(gapPlan(2, 30).captions[1].start - gapPlan(2, 30).captions[0].end, 2 / 30);
  });

  it("keeps the minimum gap by shortening the earlier caption, not below its last word start + 1 frame", () => {
    const p = gapPlan(1, 24);
    near(p.captions[1].start - p.captions[0].end, 2 / 24);
    expect(p.changes.some((c) => c.rule === "gap" && c.action === "shortened")).toBe(true);
    // Words touching: the earlier caption can only shrink to its last word start + 1 frame.
    const touching = buildCaptions([{ text: "x", start: 0, end: 1, words: W([["a", 0, 0.5], ["b", 0.5, 0.52], ["c", 0.5 + 1 / 24, 1]]) }], { frame_rate: 24, linger: 0, min_duration: 0.1, pause_break: 0.001, min_gap_frames: 2 });
    for (let i = 0; i + 1 < touching.captions.length; i++) {
      expect(touching.captions[i].end).toBeGreaterThan(touching.captions[i].words[touching.captions[i].words.length - 1].start);
      expect(touching.captions[i].end).toBeLessThanOrEqual(touching.captions[i + 1].start + 1e-9);
    }
  });

  it("lingers 0.5 s after the last word when there is room, with the standard", () => {
    const p = plan(W([["Hello", 1, 1.6], ["World", 8, 8.6]]), { standard: "bbc", frame_rate: 25, pause_break: 1 });
    near(p.captions[0].end, 2.1, 0.03);
    // Not into the minimum gap: the next caption is 0.6 s after the linger would end.
    const q = plan(W([["Hello", 1, 1.6], ["World", 2.3, 2.9]]), { standard: "bbc", frame_rate: 25, pause_break: 0.3, close_gaps_under: 0 });
    expect(q.captions[1].start - q.captions[0].end).toBeGreaterThanOrEqual(2 / 25 - 1e-6);
  });
});

describe("grammar-aware breaks", () => {
  it("does not end a line on an article, preposition or possessive when another break is near", () => {
    const lines = breakLines("I went to the shop with my friend".split(" "), 20);
    expect(lines).toHaveLength(2);
    for (const l of lines.slice(0, -1)) expect(l.split(" ").pop()).not.toMatch(/^(the|to|with|my|a|of)$/);
    expect(lines).toEqual(["I went to the shop", "with my friend"]);
  });

  it("keeps a first name with its surname and a number with its unit", () => {
    expect(breakLines("She met John Smith yesterday".split(" "), 18)).toEqual(["She met John Smith", "yesterday"]);
    const run10 = breakLines("We walked 10 km along the coast road".split(" "), 20);
    for (const l of run10.slice(0, -1)) expect(l.endsWith("10")).toBe(false);
  });

  it("prefers the longer line below when layouts cost the same", () => {
    expect(breakLines(["aaa", "bbb", "ccc", "ddd", "eee"], 12)).toEqual(["aaa bbb", "ccc ddd eee"]);
    expect(breakLines(["aaa", "bbb", "ccc", "ddd", "eee"], 12, { bottom_heavy: false })[0].length).toBeGreaterThan(0);
  });

  it("splits a caption that must split at a grammatical point among the last few words", () => {
    const words = run("She went to the store and then she bought a lot of fruit today".split(" "), { step: 0.3, dur: 0.25 });
    const p = plan(words, { max_chars_per_line: 20, max_lines: 1, pause_break: 5 });
    const ends = p.captions.map((c) => c.words[c.words.length - 1].text);
    for (const e of ends.slice(0, -1)) expect(["the", "to", "a", "of", "and", "she", "then"]).not.toContain(e);
    expect(p.captions.flatMap((c) => c.words.map((w) => w.text))).toEqual(words.map((w) => w.text));
    for (const c of p.captions) expect(c.lines[0].length).toBeLessThanOrEqual(20);
    for (const c of p.captions.slice(0, -1)) expect(c.words.length).toBeGreaterThanOrEqual(2);
  });

  it("reports a caption that ends on a weak word as a grammar violation", () => {
    // The pause forces the caption to close on "the".
    const p = plan(W([["We", 0, 0.3], ["walked", 0.4, 0.7], ["to", 0.8, 1.0], ["the", 1.0, 1.2], ["shop", 2.0, 2.4]]), { standard: "netflix_adult", frame_rate: 24, fix: false, pause_break: 0.7 });
    expect(p.violations.some((v) => v.rule === "grammar")).toBe(true);
  });
});

describe("shot changes", () => {
  const opts = (cuts: number[], extra: CaptionOptions = {}): CaptionOptions => ({ frame_rate: 24, cut_times: cuts, min_gap_frames: 2, pause_break: 3, ...extra });

  it("snaps an in-time within the zone onto the cut, after or before it", () => {
    const p = plan(W([["Hello", 5.2, 5.6], ["there", 5.6, 6.0]]), opts([5]));
    near(p.captions[0].start, 5);
    expect(p.changes).toContainEqual(expect.objectContaining({ rule: "shot_change", action: "moved_in", n: 1 }));
    // Two frames before the first word: also onto the cut.
    const q = plan(W([["Hello", 5 - 2 / 24, 5.4], ["there", 5.5, 6.0]]), opts([5]));
    near(q.captions[0].start, 5);
  });

  it("leaves an in-time at least the zone from any cut", () => {
    const p = plan(W([["Hello", 5.7, 6.0]]), opts([5]));
    near(p.captions[0].start, Math.round(5.7 * 24) / 24);
    expect(p.changes.filter((c) => c.rule === "shot_change")).toEqual([]);
  });

  it("moves an out-time within the zone before a cut to 2 frames before it", () => {
    const p = plan(W([["Hello", 1, 1.4], ["Later", 9, 9.5]]), opts([2.25], { linger: 0.25, min_duration: 1 }));
    near(p.captions[0].end, 2.25 - 2 / 24, 1e-6);
    expect(p.changes).toContainEqual(expect.objectContaining({ rule: "shot_change", n: 1 }));
  });

  it("ends a caption 2 frames before a cut it would span, when its last word is done", () => {
    const p = plan(W([["Hello", 1, 1.4], ["Later", 9, 9.5]]), opts([1.75], { linger: 0.25, min_duration: 1 }));
    near(p.captions[0].end, 1.75 - 2 / 24, 1e-6);
  });

  it("extends a caption past a cut by the zone when its words run over the cut and there is room", () => {
    const p = plan(W([["Hello", 1, 1.9], ["Later", 9, 9.5]]), opts([1.7], { linger: 0, min_duration: 0.2 }));
    near(p.captions[0].end, 1.7 + 0.5, 0.05);
    const tight = plan(W([["Hello", 1, 1.9], ["Later", 2.0, 2.5]]), opts([1.7], { linger: 0, min_duration: 0.2, pause_break: 0.05 }));
    expect(tight.captions[0].end).toBeLessThanOrEqual(tight.captions[1].start - 2 / 24 + 1e-9);
  });

  it("splits a caption whose words are on both sides of a cut, and no caption straddles it", () => {
    const words = run(["one", "two", "three", "four", "five", "six"], { step: 0.5, dur: 0.3 });
    const cut = 34 / 24;
    const p = plan(words, opts([cut], { max_chars_per_line: 40 }));
    expect(p.captions.length).toBeGreaterThanOrEqual(2);
    expect(p.changes).toContainEqual(expect.objectContaining({ rule: "shot_change", action: "split" }));
    for (const c of p.captions) expect(c.start < cut - 1e-6 && c.end > cut + 1e-6).toBe(false);
    near(p.captions[1].start, cut);
    expect(p.captions.flatMap((c) => c.words.map((w) => w.text))).toEqual(words.map((w) => w.text));
  });

  it("does not merge captions across a cut when fixing", () => {
    const words = W([["Yes.", 0, 0.3], ["No.", 0.9, 1.2]]);
    const p = plan(words, { standard: "netflix_adult", frame_rate: 24, pause_break: 0.5, cut_times: [0.6] });
    expect(p.captions).toHaveLength(2);
  });
});

describe("show_at", () => {
  const words = () => W([["one", 1, 1.32], ["two", 1.52, 1.8], ["three", 1.84, 2.2]]);
  it("is the word start minus the lead frames (default 1)", () => {
    const p = plan(words(), { frame_rate: 25 });
    const w = p.captions[0].words;
    near(w[1].show_at!, 1.52 - 1 / 25);
    near(w[0].show_at!, w[0].start);
  });
  it("lead 0 is the word start; lead 2 is two frames earlier", () => {
    near(plan(words(), { frame_rate: 25, highlight_lead_frames: 0 }).captions[0].words[1].show_at!, 1.52);
    near(plan(words(), { frame_rate: 25, highlight_lead_frames: 2 }).captions[0].words[1].show_at!, 1.52 - 2 / 25);
  });
  it("is never before the caption start or the previous word's show_at", () => {
    const p = plan(words(), { frame_rate: 25, highlight_lead_frames: 6 });
    const c = p.captions[0];
    let prev = c.start;
    for (const w of c.words) {
      expect(w.show_at!).toBeGreaterThanOrEqual(c.start - 1e-9);
      expect(w.show_at!).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(w.show_at!).toBeLessThanOrEqual(w.start + 1e-9);
      prev = w.show_at!;
    }
  });
  it("uses 1/24 s per frame without a frame rate", () => {
    const p = buildCaptions([{ text: "x", start: 1, end: 2.2, words: words() }]);
    near(p.captions[0].words[1].show_at!, 1.52 - 1 / 24, 0.002);
  });
});

describe("social chunking", () => {
  it("max_words caps the words per caption", () => {
    const p = plan(run("one two three four five six seven".split(" "), { step: 0.3, dur: 0.25 }), { max_words: 3 });
    for (const c of p.captions) expect(c.words.length).toBeLessThanOrEqual(3);
    expect(p.captions.map((c) => c.words.length)).toEqual([3, 3, 1]);
  });

  it("single_word gives one word per caption, merging a word under 8 frames into the next", () => {
    const words = W([["Go", 0, 5 / 24], ["home", 0.3, 0.7], ["now", 0.8, 1.2]]);
    const p = plan(words, { single_word: true, frame_rate: 24, pause_break: 1 });
    expect(p.captions.map((c) => text(c))).toEqual(["Go home", "now"]);
    expect(p.changes).toContainEqual(expect.objectContaining({ rule: "single_word", action: "merged", n: 1 }));
    const plain = plan(run(["one", "two", "three"], { step: 0.5, dur: 0.4 }), { single_word: true, frame_rate: 24 });
    expect(plain.captions.map((c) => text(c))).toEqual(["one", "two", "three"]);
    expect(plain.changes).toEqual([]);
  });

  it("single_word keeps a number with its unit and a first name with a surname", () => {
    const p = plan(run(["Walk", "10", "km", "with", "John", "Smith", "today"], { step: 0.5, dur: 0.4 }), { single_word: true, frame_rate: 24 });
    expect(p.captions.map((c) => text(c))).toEqual(["Walk", "10 km", "with", "John Smith", "today"]);
  });
});

describe("speakers", () => {
  const two = () => [...run(["Hello", "there", "friend."], { speaker: "speaker_0" }), ...run(["Hi", "back."], { start: 2, speaker: "speaker_1" }), ...run(["More", "talk."], { start: 4, speaker: "speaker_0" })];

  it("numbers speakers by first appearance", () => {
    const p = plan(two());
    expect(p.captions.map((c) => c.speaker_index)).toEqual([0, 1, 0]);
    expect(p.captions.every((c) => c.color === undefined)).toBe(true);
  });

  it("colour style colours by speaker: BBC order, or your own", () => {
    const p = plan(two(), { speaker_style: "color" });
    expect(p.captions.map((c) => c.color)).toEqual([SPEAKER_COLORS[0], SPEAKER_COLORS[1], SPEAKER_COLORS[0]]);
    const custom = plan(two(), { speaker_style: "color", speaker_colors: ["#ff0000", "#00ff00"] });
    expect(custom.captions.map((c) => c.color)).toEqual(["#ff0000", "#00ff00", "#ff0000"]);
    expect(p.captions[0].lines.join(" ")).not.toMatch(/:/);
  });

  it("accessibility adds a label at each change on top of colour", () => {
    const p = plan(two(), { speaker_style: "color", accessibility: true });
    expect(p.captions.map((c) => c.lines[0].split(" ")[0])).toEqual(["SPEAKER_0:", "SPEAKER_1:", "SPEAKER_0:"]);
    expect(p.captions[0].color).toBe(SPEAKER_COLORS[0]);
  });

  it("label style prefixes the first caption after each change, with names, counted in the line length", () => {
    const p = plan(two(), { speaker_style: "label", speaker_names: { speaker_0: "ANNA", speaker_1: "BEN" } });
    expect(p.captions.map((c) => c.lines[0].split(" ")[0])).toEqual(["ANNA:", "BEN:", "ANNA:"]);
    // Same speaker continuing in a second caption has no label.
    const long = plan(run("one two three four five six seven eight nine ten".split(" "), { step: 0.3, dur: 0.25, speaker: "speaker_0" }), { speaker_style: "label", max_chars_per_line: 16, max_lines: 1, pause_break: 5 });
    expect(long.captions[0].lines[0].startsWith("SPEAKER_0:")).toBe(true);
    for (const c of long.captions) expect(c.lines[0].length).toBeLessThanOrEqual(16);
    for (const c of long.captions.slice(1)) expect(c.lines[0]).not.toMatch(/SPEAKER_0:/);
  });

  it("hyphen style puts two short turns of different speakers in one two-line caption", () => {
    const words = W([["Hi", 0, 0.3, "A"], ["there.", 0.3, 0.6, "A"], ["Hello.", 0.9, 1.3, "B"]]);
    const p = plan(words, { speaker_style: "hyphen", pause_break: 1 });
    expect(p.captions).toHaveLength(1);
    expect(p.captions[0].lines).toEqual(["- Hi there.", "- Hello."]);
    // Too long for one line each: plain captions.
    const long = plan(W([["This", 0, 0.3, "A"], ["is", 0.3, 0.6, "A"], ["quite", 0.6, 0.9, "A"], ["a", 0.9, 1.2, "A"], ["long", 1.2, 1.5, "A"], ["turn", 1.5, 1.8, "A"], ["Hello.", 2.0, 2.4, "B"]]), { speaker_style: "hyphen", max_chars_per_line: 20, pause_break: 1 });
    expect(long.captions.every((c) => !c.lines[0].startsWith("- "))).toBe(true);
  });
});

describe("sound events and lyrics (SDH)", () => {
  const ELEVEN = JSON.stringify({
    words: [
      { text: "Hello", start: 0.1, end: 0.5, type: "word" },
      { text: "there.", start: 0.5, end: 0.9, type: "word" },
      { text: "(Laughter)", start: 1.0, end: 1.6, type: "audio_event" },
      { text: "Next", start: 1.8, end: 2.2, type: "word" },
      { text: "thing.", start: 2.2, end: 2.6, type: "word" },
    ],
  });

  it("makes an ElevenLabs audio_event its own [lower-case] caption between the speech", () => {
    const p = buildCaptions(parseTranscript(ELEVEN), { frame_rate: 24 });
    expect(p.captions.map((c) => [c.kind, text(c)])).toEqual([
      ["speech", "Hello there."],
      ["sound", "[laughter]"],
      ["speech", "Next thing."],
    ]);
    expect(p.captions[1].speaker).toBeUndefined();
    expect(p.captions[1].italic).toBeUndefined();
  });

  it("can be switched off, and leaves marker cues alone", () => {
    const p = buildCaptions(parseTranscript(ELEVEN), { frame_rate: 24, sdh: { sound_events: false } });
    expect(p.captions.every((c) => c.kind === "speech")).toBe(true);
    expect(p.captions.map(text).join(" ")).not.toMatch(/laughter/);
    const cues = transcriptCues(parseTranscript(ELEVEN), { unit: "word" });
    expect(cues.map((c) => c.comment)).toEqual(["Hello", "there.", "Next", "thing."]);
  });

  it("splits speech around an event that falls inside a sentence", () => {
    const json = JSON.stringify({
      words: [
        { text: "Hello", start: 0, end: 0.4, type: "word" },
        { text: "(door slams)", start: 0.45, end: 0.7, type: "audio_event" },
        { text: "friends.", start: 0.8, end: 1.2, type: "word" },
      ],
    });
    const p = buildCaptions(parseTranscript(json), { frame_rate: 24 });
    expect(p.captions.map((c) => [c.kind, text(c)])).toEqual([["speech", "Hello"], ["sound", "[door slams]"], ["speech", "friends."]]);
    for (let i = 0; i + 1 < p.captions.length; i++) expect(p.captions[i].end).toBeLessThanOrEqual(p.captions[i + 1].start + 1e-9);
  });

  it("treats words in [square brackets] as sound events, skipped by fillers and glossary", () => {
    const words = W([["So", 0, 0.3], ["[Music", 0.4, 0.8], ["playing]", 0.8, 1.2], ["um", 1.5, 1.8], ["go.", 1.9, 2.3]]);
    const p = plan(words, { cleanup: { remove_fillers: true, glossary: [{ find: "music", replace: "SONG" }] }, frame_rate: 24 });
    expect(p.captions.map((c) => [c.kind, text(c)])).toEqual([["speech", "So"], ["sound", "[music playing]"], ["speech", "go."]]);
    const off = plan(words, { sdh: { sound_events: false }, frame_rate: 24 });
    expect(off.captions.every((c) => c.kind === "speech")).toBe(true);
    expect(off.captions.map(text).join(" ")).toContain("[Music playing]");
  });

  it("never merges a sound caption with speech when fixing", () => {
    const json = JSON.stringify({
      words: [
        { text: "Yes.", start: 0, end: 0.3, type: "word" },
        { text: "(laughs)", start: 0.6, end: 0.8, type: "audio_event" },
        { text: "No.", start: 1.2, end: 1.4, type: "word" },
      ],
    });
    const p = buildCaptions(parseTranscript(json), { standard: "netflix_adult", frame_rate: 24 });
    expect(p.captions.filter((c) => c.kind === "sound")).toHaveLength(1);
    expect(p.captions.filter((c) => c.kind === "sound")[0].lines).toEqual(["[laughs]"]);
  });

  it("marks words in lyric ranges as lyric captions: italic, wrapped in music notes, counted in the line length", () => {
    const words = run(["la", "la", "land", "Back", "to", "talk"], { step: 0.5, dur: 0.4 });
    const p = plan(words, { sdh: { lyric_ranges: [{ start: 0, end: 1.6 }] }, frame_rate: 24, pause_break: 3 });
    const lyric = p.captions.find((c) => c.kind === "lyric")!;
    expect(lyric.italic).toBe(true);
    expect(lyric.lines[0].startsWith("♪ ")).toBe(true);
    expect(lyric.lines[lyric.lines.length - 1].endsWith(" ♪")).toBe(true);
    expect(lyric.words.map((w) => w.text)).toEqual(["la", "la", "land"]);
    const speech = p.captions.find((c) => c.kind === "speech")!;
    expect(text(speech)).toBe("Back to talk");
    expect(speech.italic).toBeUndefined();
    const tight = plan(run(["abcdefgh", "ijklmnop"], { step: 0.5, dur: 0.4 }), { sdh: { lyric_ranges: [{ start: 0, end: 2 }] }, max_chars_per_line: 12, pause_break: 3 });
    for (const l of tight.captions[0].lines) expect(l.length).toBeLessThanOrEqual(12);
    expect(tight.captions[0].lines).toHaveLength(2);
  });
});

describe("review fixes: shot changes, social chunking, hyphen limits", () => {
  const straddles = (p: ReturnType<typeof plan>, cuts: number[]) => p.captions.filter((c) => cuts.some((x) => c.start < x - 1e-6 && c.end > x + 1e-6));
  const wellFormed = (p: ReturnType<typeof plan>, fps: number) => {
    p.captions.forEach((c, i) => {
      for (const w of c.words) expect(w.end).toBeGreaterThanOrEqual(w.start - 1e-9);
      expect(c.end).toBeGreaterThan(c.words[c.words.length - 1].start);
      const n = p.captions[i + 1];
      if (n) expect(n.start - c.end).toBeGreaterThanOrEqual(2 / fps - 1e-6);
    });
  };

  it("never lengthens an out-time back across an earlier cut (30 fps, two cuts)", () => {
    const cuts = [3.6333, 3.9667];
    const p = plan(W([["will", 3.256, 3.505], ["of", 4.841, 5.297]]), { standard: "social_9x16", frame_rate: 30, cut_times: cuts });
    expect(straddles(p, cuts.map((x) => Math.round(x * 30) / 30))).toEqual([]);
    expect(p.violations.filter((v) => v.rule === "shot_change")).toEqual([]);
  });

  it("a single word before two close cuts ends before the first (24 fps)", () => {
    const cuts = [1.5, 1.8333];
    const p = plan(W([["hello", 1.0, 1.4]]), { standard: "netflix_adult", frame_rate: 24, cut_times: cuts });
    expect(p.captions[0].end).toBeLessThanOrEqual(1.5 - 2 / 24 + 1e-6);
    expect(straddles(p, [1.5, 44 / 24])).toEqual([]);
  });

  it("gap closing and linger never carry a caption across a cut whose speech ended before it", () => {
    for (const standard of ["netflix_adult", "social_9x16"] as const) {
      const p = plan(W([["quickly", 1.1, 1.467], ["beautiful", 2.361, 2.82]]), { standard, frame_rate: 24, cut_times: [1.5417] });
      near(p.captions[0].end, 35 / 24);
      expect(straddles(p, [37 / 24])).toEqual([]);
    }
  });

  it("does not snap an in-time onto a cut after the caption's own words ended", () => {
    const words = W([["the", 1.833, 1.917], ["said", 1.992, 2.164], ["they", 2.251, 2.525], ["with", 2.597, 3.132], ["Smith", 3.196, 3.763], ["pm", 3.8, 4.224], ["on", 4.329, 4.41], ["we", 4.455, 4.749], ["we", 4.855, 5.192]]);
    const p = plan(words, { standard: "netflix_adult", frame_rate: 24, cut_times: [1.9583, 5] });
    wellFormed(p, 24);
    // The last word runs over the cut at 5 s, so that one cannot be split; it holds 0.5 s past it instead.
    expect(straddles(p, [47 / 24])).toEqual([]);
    expect(p.captions[0].end).toBeGreaterThanOrEqual(5.5 - 1e-6);
    expect(p.violations.filter((v) => v.rule === "gap" || v.rule === "overlap")).toEqual([]);
  });

  it("two one-word captions around a cut do not overlap (25 fps, speaker colour)", () => {
    const p = plan(W([["on", 4.529, 4.579, "s1"], ["it", 4.714, 4.87, "s0"]]), { standard: "dcmp", frame_rate: 25, speaker_style: "color", cut_times: [4.64] });
    wellFormed(p, 25);
    expect(p.violations.filter((v) => v.rule === "gap" || v.rule === "overlap")).toEqual([]);
  });

  it("a first word that ends before the cut and is followed by more words starts on the cut", () => {
    const p = plan(W([["the", 1.833, 1.917], ["said", 2.0, 2.3], ["so", 2.4, 2.8]]), { standard: "netflix_adult", frame_rate: 24, cut_times: [47 / 24] });
    near(p.captions[0].start, 47 / 24);
    for (const w of p.captions[0].words) expect(w.end).toBeGreaterThanOrEqual(w.start);
  });

  it("splitAtCuts leaves a sliver before a cut alone instead of splitting it off", () => {
    const p = plan(W([["Hello", 0.9, 1.3], ["there", 1.5, 2.2], ["my", 2.3, 2.6], ["friends", 2.7, 3.4], ["today", 3.5, 4.0]]), { standard: "netflix_adult", frame_rate: 24, cut_times: [1.4] });
    // "Hello" alone would have room for under the 5/6 s minimum, so it is not a caption of its own.
    expect(p.captions.every((c) => c.words.length > 1 || c.words[0].text !== "Hello")).toBe(true);
  });

  it("single_word does not split a first name from a surname when merging a short word", () => {
    const p = plan(W([["a", 0, 0.1], ["b", 0.12, 0.2], ["The", 0.3, 0.4], ["10", 0.5, 0.6], ["km", 0.6, 0.9], ["Anna", 1.0, 1.4], ["Smith", 1.4, 1.8]]), { single_word: true, frame_rate: 24 });
    const texts = p.captions.map((c) => c.words.map((w) => w.text).join(" "));
    expect(texts).toContain("Anna Smith");
    expect(texts.some((t) => t.endsWith(" The") || t === "The")).toBe(false);
    expect(texts).toContain("The 10 km");
  });

  it("hyphen style makes no pair when single_word is on, and respects max_words", () => {
    const words = W([["Yes.", 0, 0.5, "s0"], ["No way.", 0.6, 1.2, "s1"]]);
    const base: CaptionOptions = { frame_rate: 24, speaker_style: "hyphen" };
    expect(plan(words, base).captions).toHaveLength(1);
    expect(plan(words, { ...base, single_word: true }).captions.length).toBeGreaterThan(1);
    expect(plan(words, { ...base, max_words: 2 }).captions.length).toBe(2);
    expect(plan(words, { ...base, max_words: 3 }).captions).toHaveLength(1);
  });
});

describe("number and unit rule", () => {
  it("only a unit word keeps a number company", () => {
    expect(weakEndReason("2020", "when")).toBeUndefined();
    expect(weakEndReason("2020", "and")).toBeUndefined();
    expect(breakPenalty("2020", "and")).toBeLessThan(8);
    for (const u of ["km", "pm", "%", "percent", "dollars", "mph", "kg", "million"]) {
      expect(weakEndReason("10", u)).toBe("splits a number from its unit");
      expect(breakPenalty("10", u)).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("social chunking with max_words", () => {
  const social = { standard: "social_9x16" as const, max_words: 3, frame_rate: 30 };
  const weakLast = (c: { lines: string[] }, next?: { lines: string[] }) => {
    const last = c.lines.join(" ").split(" ").pop()!;
    return next !== undefined && weakEndReason(last, next.lines.join(" ").split(" ")[0]) !== undefined;
  };

  it("does not end a chunk on a preposition, article or conjunction when a nearby break is clean", () => {
    // 'for Ogilvy in London at the new studio and ...' cut into threes ends on 'in', 'the', 'and'.
    const texts = "She worked for Ogilvy in London at the new studio and then moved".split(" ");
    const p = plan(run(texts, { step: 0.32, dur: 0.28 }), social);
    p.captions.forEach((c, i) => expect(weakLast(c, p.captions[i + 1]), `caption ${i + 1} "${text(c)}"`).toBe(false));
    // The words are all there, in order, and no chunk is over max_words + 1.
    expect(p.captions.flatMap((c) => c.words.map((w) => w.text))).toEqual(texts);
    for (const c of p.captions) expect(c.words.length).toBeLessThanOrEqual(4);
  });

  it("prefers a break at punctuation: the last word of a full chunk moves on", () => {
    const p = plan(run("Fresh bread, from the bakery".split(" "), { step: 0.3, dur: 0.25 }), { max_words: 3 });
    expect(p.captions.map(text)).toEqual(["Fresh bread,", "from the bakery"]);
  });

  it("takes an extra word or hands one on rather than end on a preposition, and leaves plain words at max_words", () => {
    const p = plan(run("Fresh bread from London every single morning".split(" "), { step: 0.4, dur: 0.3 }), { max_words: 3 });
    p.captions.forEach((c, i) => expect(weakLast(c, p.captions[i + 1]), text(c)).toBe(false));
    const plain = plan(run("one two three four five six seven".split(" "), { step: 0.3, dur: 0.25 }), { max_words: 3 });
    expect(plain.captions.map((c) => c.words.length)).toEqual([3, 3, 1]);
  });

  it("merges a too-short chunk past max_words when fix is on, and says so", () => {
    // 'at the new' 0.37 s and 'It went' 0.23 s: max_words 3 blocks the plain merge.
    const ws: TranscriptWord[] = [];
    const add = (tx: string, start: number, dur: number) => ws.push({ text: tx, start, end: start + dur });
    ["Alpha", "Bravo", "Charlie"].forEach((w, i) => add(w, i * 0.4, 0.35));
    // A quick chunk between two full ones: 0.1 s apart, so it cannot stay up 0.5 s and the next chunk starts 2 frames after it.
    ["Delta", "Echo", "Foxtrot"].forEach((w, i) => add(w, 1.5 + i * 0.1, 0.09));
    ["Golf", "Hotel", "India"].forEach((w, i) => add(w, 1.9 + i * 0.4, 0.35));
    const fixed = plan(ws, { standard: "social_9x16", max_words: 3, frame_rate: 30, fix: true });
    expect(fixed.violations.filter((v) => v.rule === "min_duration")).toEqual([]);
    const over = fixed.changes.filter((c) => c.action === "merged_over_max_words");
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((c) => c.rule === "min_duration" || c.rule === "cps")).toBe(true);
    expect(fixed.captions.some((c) => c.words.length > 4)).toBe(true);
    expect(fixed.captions.every((c) => c.words.length <= 6)).toBe(true);
    // fix off: nothing merged past the limit, the violations stay for the caller.
    const raw = plan(ws, { standard: "social_9x16", max_words: 3, frame_rate: 30, fix: false });
    expect(raw.changes.some((c) => c.action === "merged_over_max_words")).toBe(false);
    // single_word keeps its one-word captions.
    const one = plan(ws, { standard: "social_9x16", max_words: 3, frame_rate: 30, single_word: true });
    expect(one.changes.some((c) => c.action === "merged_over_max_words")).toBe(false);
  });

  it("single_word is unchanged by the word-limit break", () => {
    const p = plan(run("one two three four".split(" "), { step: 0.6, dur: 0.4 }), { single_word: true, max_words: 3 });
    expect(p.captions.map(text)).toEqual(["one", "two", "three", "four"]);
  });

  it("fuzz: random speech never loses words, stays within max_words + 1, and rarely ends on a weak word", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const weak = "the a an in at of for and but to with on is was we they".split(" ");
    const strong = "brief studio London Ogilvy moved film lights camera team story launch client quickly simple great".split(" ");
    let total = 0;
    let weakEnds = 0;
    for (let run_ = 0; run_ < 60; run_++) {
      const n = 12 + Math.floor(rnd() * 20);
      const texts: string[] = [];
      for (let i = 0; i < n; i++) texts.push(rnd() < 0.3 ? weak[Math.floor(rnd() * weak.length)] : strong[Math.floor(rnd() * strong.length)]);
      let t = 0;
      const ws: TranscriptWord[] = texts.map((tx) => {
        const start = t;
        t += 0.25 + rnd() * 0.15;
        return { text: tx, start, end: t - 0.04 };
      });
      const fix = rnd() < 0.5;
      const p = plan(ws, { standard: "social_9x16", max_words: 3, frame_rate: 30, fix });
      expect(p.captions.flatMap((c) => c.words.map((w) => w.text))).toEqual(texts);
      // With fix on, a caption under the minimum duration joins a neighbour even past max_words (up to twice the limit);
      // nothing in this speech has another speaker or a cut, so none may remain unless it is the only caption.
      if (fix && p.captions.length > 1) expect(p.violations.filter((v) => v.rule === "min_duration"), JSON.stringify(p.violations)).toEqual([]);
      p.captions.forEach((c, i) => {
        expect(c.words.length).toBeLessThanOrEqual(fix ? 6 : 4);
        if (i + 1 < p.captions.length) {
          total++;
          if (weakLast(c, p.captions[i + 1])) weakEnds++;
        }
      });
    }
    // Where a clean break is within one word of the limit there is none left; only runs of weak words can force one.
    expect(weakEnds / total).toBeLessThan(0.06);
  });
});
