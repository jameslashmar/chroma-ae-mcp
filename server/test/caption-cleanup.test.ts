import { describe, expect, it } from "vitest";
import { cleanupWords, type CleanWord } from "../src/caption-cleanup.js";
import { buildCaptions } from "../src/transcript.js";

/** Words 0.5 s apart, 0.4 s long, from texts. */
const mk = (texts: string[], opts: { dur?: number; step?: number } = {}): CleanWord[] =>
  texts.map((text, i) => ({ text, start: i * (opts.step ?? 0.5), end: i * (opts.step ?? 0.5) + (opts.dur ?? 0.4) }));
const texts = (ws: CleanWord[]) => ws.map((w) => w.text);

describe("cleanupWords", () => {
  it("drops words at or after drop_after_s", () => {
    const r = cleanupWords(mk(["a", "b", "c", "d"]), { drop_after_s: 1, drop_music_tokens: false, min_word_s: 0 });
    expect(texts(r.words)).toEqual(["a", "b"]);
    expect(r.report.dropped_after_end).toBe(2);
  });

  it("drops music notes, the replacement character and symbol-only tokens, by default", () => {
    const r = cleanupWords(mk(["♪", "hello", "�", "♫♫", "-", "world"]), {});
    expect(texts(r.words)).toEqual(["hello", "world"]);
    expect(r.report.dropped_music_tokens).toBe(4);
    const kept = cleanupWords(mk(["♪", "hello"]), { drop_music_tokens: false });
    expect(texts(kept.words)).toEqual(["♪", "hello"]);
  });

  it("drops words under min_word_s (default 0.05), keeps all with 0, never drops estimated words", () => {
    const ws = mk(["a", "b", "c"]);
    ws[1].end = ws[1].start + 0.01;
    expect(texts(cleanupWords(ws, {}).words)).toEqual(["a", "c"]);
    expect(cleanupWords(ws, {}).report.dropped_short).toBe(1);
    expect(texts(cleanupWords(ws, { min_word_s: 0 }).words)).toEqual(["a", "b", "c"]);
    const est = ws.map((w) => ({ ...w, estimated: true }));
    expect(texts(cleanupWords(est, {}).words)).toEqual(["a", "b", "c"]);
  });

  it("removes the default fillers and moves their punctuation to the word before", () => {
    const r = cleanupWords(mk(["Well", "um,", "then", "uh", "go", "Mhm."]), { remove_fillers: true });
    expect(texts(r.words)).toEqual(["Well,", "then", "go."]);
    expect(r.report.fillers_removed).toBe(3);
  });

  it("gives a sentence-opening filler's capital to the next word", () => {
    const r = cleanupWords(mk(["Um,", "we", "left.", "Uh", "then", "we", "um", "ran."]), { remove_fillers: true });
    expect(texts(r.words)).toEqual(["We", "left.", "Then", "we", "ran."]);
  });

  it("collapses a repeat across a comma ('the, the') but keeps emphatic and sentence-end repeats", () => {
    const r = cleanupWords(mk(["So", "the,", "the", "brief", "was", "simple"]), { remove_stutters: true });
    expect(texts(r.words)).toEqual(["So", "the", "brief", "was", "simple"]);
    expect(r.report.stutters_removed).toBe(1);
    expect(texts(cleanupWords(mk(["It", "was", "a,", "A", "day"]), { remove_stutters: true }).words)).toEqual(["It", "was", "A", "day"]);
    expect(texts(cleanupWords(mk(["Go.", "Go", "now"]), { remove_stutters: true }).words)).toEqual(["Go.", "Go", "now"]);
    expect(texts(cleanupWords(mk(["very,", "very", "good"]), { remove_stutters: true }).words)).toEqual(["very,", "very", "good"]);
  });

  it("takes its own filler list instead of the default", () => {
    const r = cleanupWords(mk(["so", "like", "um", "go"]), { remove_fillers: true, filler_words: ["like"] });
    expect(texts(r.words)).toEqual(["so", "um", "go"]);
  });

  it("collapses stutters and repeats, keeping the later word and its end", () => {
    const ws = mk(["I-", "I", "think", "the", "the", "plan", "th-", "the", "end"]);
    const r = cleanupWords(ws, { remove_stutters: true });
    expect(texts(r.words)).toEqual(["I", "think", "the", "plan", "the", "end"]);
    expect(r.report.stutters_removed).toBe(3);
    expect(r.words[0].start).toBe(0);
    expect(r.words[0].end).toBeCloseTo(0.9, 6);
    // Case-insensitive, but a comma means it was meant.
    expect(texts(cleanupWords(mk(["The", "the"]), { remove_stutters: true }).words)).toEqual(["the"]);
    expect(texts(cleanupWords(mk(["no,", "no"]), { remove_stutters: true }).words)).toEqual(["no,", "no"]);
  });

  it("replaces glossary phrases whole-word, in order, with the span's times", () => {
    const ws = mk(["we", "use", "after", "effects.", "Aftereffects", "is", "chroma"]);
    const r = cleanupWords(ws, {
      glossary: [
        { find: "after effects", replace: "After Effects" },
        { find: "chroma", replace: "CHROMA", case_sensitive: true },
        { find: "Chroma", replace: "Chroma Studio", case_sensitive: true },
      ],
    });
    // The phrase becomes two words sharing the span (the AE word count), the full stop stays.
    expect(texts(r.words)).toEqual(["we", "use", "After", "Effects.", "Aftereffects", "is", "CHROMA"]);
    expect(r.report.glossary_replacements).toBe(2);
    expect(r.words[2].start).toBe(1);
    expect(r.words[3].end).toBeCloseTo(1.9, 6);
  });

  it("case-sensitive glossary entries only match their case", () => {
    const r = cleanupWords(mk(["chroma", "Chroma"]), { glossary: [{ find: "chroma", replace: "X", case_sensitive: true }] });
    expect(texts(r.words)).toEqual(["X", "Chroma"]);
    expect(r.report.glossary_replacements).toBe(1);
    const gone = cleanupWords(mk(["a", "um", "b"]), { glossary: [{ find: "um", replace: "" }] });
    expect(texts(gone.words)).toEqual(["a", "b"]);
  });

  it("upper-cases, or sentence-cases (lower, then capital at sentence starts and for I)", () => {
    const ws = mk(["HELLO", "THERE.", "I", "AM", "I'M", "HERE"]);
    expect(texts(cleanupWords(ws, { case: "upper" }).words)).toEqual(["HELLO", "THERE.", "I", "AM", "I'M", "HERE"]);
    expect(texts(cleanupWords(mk(["hello", "there."]), { case: "upper" }).words)).toEqual(["HELLO", "THERE."]);
    expect(texts(cleanupWords(ws, { case: "sentence" }).words)).toEqual(["Hello", "there.", "I", "am", "I'm", "here"]);
    expect(texts(cleanupWords(mk(["a", "b."]), { case: "as_is" }).words)).toEqual(["a", "b."]);
  });

  it("strips punctuation but keeps inner apostrophes, and remembers the sentence ends", () => {
    const ws = mk(["Don't", "go,", "well-known", "3.5", "“quote.”", "x?"]);
    const r = cleanupWords(ws, { strip_punctuation: true });
    expect(texts(r.words)).toEqual(["Don't", "go", "well-known", "3.5", "quote", "x"]);
    expect(r.words[1].sentence_end).toBe(false);
    expect(r.words[5].sentence_end).toBe(true);
    expect(r.words[1].gram).toBe("go,");
  });

  it("hands a dropped cue start to the next word", () => {
    const ws = mk(["um", "hello"]);
    ws[0].cue_start = true;
    const r = cleanupWords(ws, { remove_fillers: true });
    expect(r.words).toHaveLength(1);
    expect(r.words[0].cue_start).toBe(true);
  });
});

describe("buildCaptions with cleanup", () => {
  const seg = (words: string[]) => [{ text: "x", start: 0, end: words.length * 0.5, words: mk(words) }];

  it("returns the report; without cleanup nothing is dropped and there is no report", () => {
    const withIt = buildCaptions(seg(["um", "hello", "there"]), { cleanup: { remove_fillers: true } });
    expect(withIt.cleanup?.fillers_removed).toBe(1);
    expect(withIt.captions[0].lines).toEqual(["hello there"]);
    const without = buildCaptions(seg(["um", "hello", "there"]));
    expect(without.cleanup).toBeUndefined();
    expect(without.captions[0].lines).toEqual(["um hello there"]);
    // The default-on clean-ups only run when a cleanup object is passed.
    const music = buildCaptions(seg(["♪", "hello", "there"]));
    expect(music.captions[0].words).toHaveLength(3);
    expect(buildCaptions(seg(["♪", "hello", "there"]), { cleanup: {} }).captions[0].words).toHaveLength(2);
  });

  it("still ends a caption at a sentence end when punctuation is stripped", () => {
    const words = ["This", "is", "a", "fairly", "long", "sentence.", "And", "here", "is", "more"];
    const plan = buildCaptions([{ text: "x", start: 0, end: 5, words: mk(words) }], { cleanup: { strip_punctuation: true }, pause_break: 5 });
    expect(plan.captions[0].lines.join(" ")).toBe("This is a fairly long sentence");
    expect(plan.captions[1].lines.join(" ")).toBe("And here is more");
  });

  it("throws when clean-up leaves nothing", () => {
    expect(() => buildCaptions(seg(["um", "uh"]), { cleanup: { remove_fillers: true } })).toThrow(/no words/);
  });
});

describe("review fixes", () => {
  const w = (text: string, start = 0, end = 1): CleanWord => ({ text, start, end });
  const clean = (words: CleanWord[], opts: Parameters<typeof cleanupWords>[1]) => cleanupWords(words, opts).words;

  it("sentence case capitalises I before punctuation", () => {
    const out = clean([w("said", 0, 1), w("I.", 1, 2), w("Then", 2, 3), w("I,", 3, 4), w("left", 4, 5)], { case: "sentence" } as never);
    expect(out.map((x) => x.text)).toEqual(["Said", "I.", "Then", "I,", "left"]);
  });

  it("strip_punctuation keeps joining characters inside a token", () => {
    const out = clean([w("well—known", 0, 1), w("and/or", 1, 2), w("a.m.", 2, 3), w("3.5", 3, 4), w("Hello,", 4, 5)], { strip_punctuation: true } as never);
    expect(out.map((x) => x.text)).toEqual(["well-known", "and/or", "a.m", "3.5", "Hello"]);
  });

  it("strip_punctuation splits wait...what into two words sharing the time by character count", () => {
    const out = clean([w("wait...what", 0, 0.9), w("so", 1, 2)], { strip_punctuation: true } as never);
    expect(out.map((x) => x.text)).toEqual(["wait", "what", "so"]);
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBeCloseTo(0.45, 6);
    expect(out[1].start).toBeCloseTo(0.45, 6);
    expect(out[1].end).toBeCloseTo(0.9, 6);
  });
});
