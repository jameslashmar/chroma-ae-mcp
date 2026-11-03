import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeCaptionsPlanSchema,
  AeCaptionsReadSchema,
  AeCaptionsSchema,
  captionsMismatches,
  captionsTools,
  expectedSingleKeys,
  planCaptions,
  type CaptionsRead,
  type ReadCaption,
} from "../src/tools/ext/captions.js";
import { breakLines, buildCaptions, greedyLineCount, parseTranscript, timedWords, type Caption } from "../src/transcript.js";
import { DEFAULT_MARGINS } from "../src/tools/ext/reframe.js";
import { FakeGroup, FakeProject, FakeProperty, GUARD, PropertyValueType, TextDocument, loadHost, type FakeComp, type FakeLayer } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => captionsTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

// ---------- transcripts ----------

/** ElevenLabs-style words: two sentences with a pause between. */
const WORDS_JSON = JSON.stringify({
  words: [
    { text: "Hello", start: 0.4, end: 0.8, type: "word" },
    { text: "there", start: 0.8, end: 1.2, type: "word" },
    { text: "friends.", start: 1.2, end: 1.8, type: "word" },
    { text: "Second", start: 3.2, end: 3.6, type: "word" },
    { text: "caption", start: 3.6, end: 4.0, type: "word" },
    { text: "here", start: 4.0, end: 4.4, type: "word" },
  ],
});

const SRT = `1
00:00:01,000 --> 00:00:03,000
Welcome to the show everyone

2
00:00:03,500 --> 00:00:05,000
Today we talk captions
`;

describe("schemas", () => {
  it("need exactly one of path and text, and expect for the write", () => {
    const base = { comp_id: 1, expect: expectArg };
    expect(AeCaptionsSchema.safeParse({ ...base, transcript: { text: SRT } }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...base, transcript: {} }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ ...base, transcript: { text: SRT, path: "C:/x.srt" } }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ comp_id: 1, transcript: { text: SRT } }).success).toBe(false);
  });

  it("range-checks the break limits, colours and mode", () => {
    const base = { comp_id: 1, transcript: { text: SRT }, expect: expectArg };
    expect(AeCaptionsSchema.safeParse({ ...base, max_chars_per_line: 3 }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ ...base, max_lines: 9 }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ ...base, highlight: { color: [1, 0] } }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ ...base, highlight: { color: [1, 0.8, 0] }, box: { opacity: 50 } }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...base, mode: "grid" }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ ...base, mode: "single", first_number: 5 }).success).toBe(false);
    expect(AeCaptionsSchema.safeParse({ ...base, style: { justification: "full" } }).success).toBe(false);
  });

  it("the plan and read tools take no expect", () => {
    expect(AeCaptionsPlanSchema.safeParse({ transcript: { text: SRT } }).success).toBe(true);
    expect(AeCaptionsReadSchema.safeParse({ comp_id: 1 }).success).toBe(true);
  });

  it("only the write is described with the safety guidance", () => {
    expect(tool("ae_captions").description).toMatch(/IMPORTANT/);
    expect(tool("ae_captions_plan").description).not.toMatch(/IMPORTANT/);
    expect(tool("ae_captions_read").description).not.toMatch(/IMPORTANT/);
  });
});

// ---------- pure logic ----------

describe("breakLines", () => {
  it("keeps a short caption on one line", () => {
    expect(breakLines(["Hello", "there"], 32)).toEqual(["Hello there"]);
    expect(breakLines([], 32)).toEqual([]);
  });

  it("balances two lines instead of filling the first", () => {
    expect(greedyLineCount([1, 6, 4, 5, 6], 20)).toBe(2);
    expect(breakLines("I really like green apples".split(" "), 20)).toEqual(["I really like", "green apples"]);
  });

  it("gives an over-long word a line of its own", () => {
    expect(breakLines(["a", "extraordinarily", "b"], 8)).toEqual(["a", "extraordinarily", "b"]);
  });
});

describe("buildCaptions", () => {
  const segs = () => parseTranscript(WORDS_JSON);

  it("splits at the pause and rounds to frames", () => {
    const plan = buildCaptions(segs(), { frame_rate: 25 });
    expect(plan.captions).toHaveLength(2);
    expect(plan.estimated_word_times).toBe(false);
    const [a, b] = plan.captions;
    expect(a.lines).toEqual(["Hello there friends."]);
    expect(a.start).toBeCloseTo(0.4, 6);
    // last word 1.8 + 0.25 linger = 2.05; the 1 s minimum is shorter.
    expect(a.end).toBeCloseTo(2.04, 6);
    expect(b.start).toBeCloseTo(3.2, 6);
    expect(a.words.map((w) => w.text)).toEqual(["Hello", "there", "friends."]);
    for (const c of plan.captions) {
      for (const t of [c.start, c.end, ...c.words.map((w) => w.start)]) expect(Math.abs(t * 25 - Math.round(t * 25))).toBeLessThan(1e-6);
    }
  });

  it("applies the offset and holds a short caption for the minimum time up to the next one", () => {
    const plan = buildCaptions(
      segs(),
      { offset: 10, min_duration: 3, linger: 0, frame_rate: 25 }
    );
    expect(plan.captions[0].start).toBeCloseTo(10.4, 6);
    // 0.4 + 3 = 3.4 would pass the next caption's start (3.2): held up to it.
    expect(plan.captions[0].end).toBeCloseTo(13.2, 6);
  });

  it("splits at a speaker change and at the line and line-count limits", () => {
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((text, i) => ({
      text,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      ...(i >= 4 ? { speaker: "B" } : {}),
    }));
    const bySpeaker = buildCaptions([{ text: "x", start: 0, end: 4, words }], { max_chars_per_line: 40 });
    expect(bySpeaker.captions.map((c) => c.speaker)).toEqual([undefined, "B"]);
    const tight = buildCaptions([{ text: "x", start: 0, end: 4, words: words.map(({ speaker, ...w }) => w) }], { max_chars_per_line: 10, max_lines: 2 });
    for (const c of tight.captions) expect(c.lines.length).toBeLessThanOrEqual(2);
    expect(tight.captions.length).toBeGreaterThan(1);
    // Lines joined give the words back, in order.
    expect(tight.captions.flatMap((c) => c.lines.join(" ").split(" "))).toEqual(words.map((w) => w.text));
  });

  it("splits a caption that would run past max_duration", () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ text: `w${i}`, start: i * 2, end: i * 2 + 1.5 }));
    const plan = buildCaptions([{ text: "x", start: 0, end: 12, words }], { max_duration: 4, pause_break: 5 });
    expect(plan.captions.length).toBeGreaterThan(1);
    for (const c of plan.captions) expect(c.words[c.words.length - 1].end - c.words[0].start).toBeLessThanOrEqual(4 + 1e-9);
  });

  it("never overlaps captions and keeps words a frame apart", () => {
    const words = [
      { text: "a", start: 0, end: 0.001 },
      { text: "b", start: 0.001, end: 0.002 },
      { text: "c", start: 0.002, end: 0.5 },
    ];
    const plan = buildCaptions([{ text: "x", start: 0, end: 0.5, words }], { frame_rate: 25 });
    const ws = plan.captions[0].words;
    expect(ws[1].start - ws[0].start).toBeGreaterThanOrEqual(0.04 - 1e-9);
    expect(ws[2].start - ws[1].start).toBeGreaterThanOrEqual(0.04 - 1e-9);
    expect(plan.captions[0].end).toBeGreaterThan(ws[2].start);
  });

  it("estimates word times for SRT and says so", () => {
    const plan = buildCaptions(parseTranscript(SRT), { frame_rate: 25 });
    expect(plan.estimated_word_times).toBe(true);
    expect(plan.warnings.join(" ")).toMatch(/estimates/);
    expect(plan.captions).toHaveLength(2);
    expect(plan.captions[0].words).toHaveLength(5);
    expect(plan.captions[0].words[0].start).toBeCloseTo(1, 6);
  });

  it("splits a 'word' that holds spaces and warns about fast captions", () => {
    const t = timedWords({ text: "x", start: 0, end: 2, words: [{ text: "New York", start: 0, end: 2 }] });
    expect(t.words.map((w) => w.text)).toEqual(["New", "York"]);
    const fast = buildCaptions([{ text: "x", start: 0, end: 0.5, words: [{ text: "supercalifragilisticexpialidocious", start: 0, end: 0.5 }] }], { min_duration: 0.1, linger: 0, max_chars_per_line: 8 });
    expect(fast.warnings.join(" ")).toMatch(/characters per second/);
    expect(fast.warnings.join(" ")).toMatch(/longer than max_chars_per_line/);
  });
});

describe("planCaptions", () => {
  it("windows the transcript with from_s and to_s", () => {
    const all = planCaptions({ transcript: { text: WORDS_JSON } });
    expect(all.captions).toHaveLength(2);
    const late = planCaptions({ transcript: { text: WORDS_JSON, from_s: 3 } });
    expect(late.captions).toHaveLength(1);
    expect(late.captions[0].lines.join(" ")).toBe("Second caption here");
    expect(() => planCaptions({ transcript: { text: WORDS_JSON, from_s: 50 } })).toThrow(/No transcript segment/);
  });

  it("refuses a negative offset that puts a caption before 0, and a relative path", () => {
    expect(() => planCaptions({ transcript: { text: WORDS_JSON, offset: -1 } })).toThrow(/before 0/);
    expect(() => planCaptions({ transcript: { path: "rel.srt" } })).toThrow(/absolute/);
  });

  it("reads a transcript file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-captions-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "vo.srt");
    fs.writeFileSync(file, SRT);
    expect(planCaptions({ transcript: { path: file } }).captions).toHaveLength(2);
  });

  it("refuses more than 500 captions", () => {
    const lines = Array.from({ length: 501 }, (_, i) => `${i + 1}\n00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")},000 --> 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")},500\nLine ${i}\n`);
    expect(() => planCaptions({ transcript: { text: lines.join("\n") }, min_duration: 0.1 })).toThrow(/at most 500/);
  });

  it("ae_captions_plan returns the captions without AE", async () => {
    const out = await tool("ae_captions_plan").handler(AeCaptionsPlanSchema.parse({ transcript: { text: WORDS_JSON }, frame_rate: 25 }), {} as ToolContext);
    expect(out.count).toBe(2);
    expect(out.captions[0]).toMatchObject({ n: 1, text: "Hello there friends.", words: 3 });
    const bad = await tool("ae_captions_plan").handler(AeCaptionsPlanSchema.parse({ transcript: { text: "not a transcript" } }), {} as ToolContext);
    expect(bad).toMatchObject({ ok: false, error: "bad_transcript" });
  });
});

// ---------- receipt checks ----------

const rc = (n: number, name: string, text: string, inP: number, outP: number, extra: Partial<ReadCaption> = {}): ReadCaption => ({
  number: n,
  name,
  id: 100 + n,
  index: n,
  kind: "text",
  inPoint: inP,
  outPoint: outP,
  numKeys: 0,
  text,
  justification: "center",
  highlight: { present: false },
  ...extra,
});

const readOf = (captions: ReadCaption[], extra: Partial<CaptionsRead> = {}): CaptionsRead => ({
  comp_id: 1,
  width: 1080,
  height: 1920,
  frameDuration: 0.04,
  safe: { left: 64, right: 64, top: 230, bottom: 384, width: 952 },
  mode: "layers",
  captions,
  boxes: [],
  total_captions: captions.length,
  total_boxes: 0,
  truncated: false,
  ...extra,
});

describe("captionsMismatches", () => {
  const caps: Caption[] = [
    { start: 0.4, end: 2, lines: ["Hello", "there"], words: [{ text: "Hello", start: 0.4, end: 1 }, { text: "there", start: 1, end: 2 }] },
    { start: 3.2, end: 4.4, lines: ["Second one"], words: [{ text: "Second", start: 3.2, end: 3.8 }, { text: "one", start: 3.8, end: 4.4 }] },
  ];
  const written = { timings: [[0.4, 2], [3.2, 4.4]] as Array<[number, number]>, created: ["Caption 001", "Caption 002"] };
  const good = readOf([rc(1, "Caption 001", "Hello\rthere", 0.4, 2), rc(2, "Caption 002", "Second one", 3.2, 4.4)]);
  const base = { mode: "layers" as const, first_number: undefined, highlight: undefined, box: undefined, style: undefined };

  it("accepts a matching read-back", () => {
    expect(captionsMismatches(base, true, caps, good, written)).toEqual([]);
    expect(captionsMismatches(base, true, caps, null, written)).toEqual([]);
  });

  it("flags text, timing, a missing layer and stale layers", () => {
    const bad = readOf([rc(1, "Caption 001", "Hello", 0.4, 2.5), rc(3, "Caption 003", "old", 5, 6)]);
    const paths = captionsMismatches(base, true, caps, bad, written).map((x) => x.path);
    expect(paths).toContain("captions[1].text");
    expect(paths).toContain("captions[1].outPoint");
    expect(paths).toContain("captions[2]");
    expect(paths).toContain("stale");
    // Stale layers are not judged when the user asked to keep them.
    expect(captionsMismatches(base, false, caps, good, written)).toEqual([]);
  });

  it("does not judge layers a capped read did not list", () => {
    const capped = readOf([rc(1, "Caption 001", "Hello\rthere", 0.4, 2)], { total_captions: 900, truncated: true });
    expect(captionsMismatches(base, true, caps, capped, written)).toEqual([]);
  });

  it("checks the highlight, the boxes' expressions and the justification of new layers", () => {
    const args = { ...base, highlight: { color: [1, 1, 0] }, box: { color: [0, 0, 0] } };
    const noHl = readOf(
      [rc(1, "Caption 001", "Hello\rthere", 0.4, 2, { justification: "left" }), rc(2, "Caption 002", "Second one", 3.2, 4.4)],
      { boxes: [{ number: 1, name: "Caption 001 Box", id: 1, inPoint: 0, outPoint: 1, expression_errors: ["size: bad"] }] }
    );
    const paths = captionsMismatches(args, true, caps, noHl, { ...written, highlight_keys: 4 }).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["captions[1].justification", "highlight.keys", "highlight.present", "boxes", "boxes[1].expression"]));
  });

  it("checks a single layer's Source Text keys, including the blank key in a gap", () => {
    const keys = expectedSingleKeys(caps, written.timings);
    expect(keys).toEqual([
      { time: 0.4, text: "Hello\rthere" },
      { time: 2, text: "" },
      { time: 3.2, text: "Second one" },
      { time: 4.4, text: "" },
    ]);
    const single = readOf([rc(1, "Caption", "Hello\rthere", 0.4, 4.4, { numKeys: 4, keys })], { mode: "single" });
    const args = { ...base, mode: "single" as const };
    expect(captionsMismatches(args, false, caps, single, written)).toEqual([]);
    const wrong = readOf([rc(1, "Caption", "x", 0.4, 4.4, { numKeys: 3, keys: keys.slice(0, 3) })], { mode: "single" });
    expect(captionsMismatches(args, false, caps, wrong, written).map((x) => x.path)).toContain("caption.numKeys");
  });
});

// ---------- the guarded flow with a fake bridge ----------

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-captions-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

describe("ae_captions flow", () => {
  const args = () =>
    AeCaptionsSchema.parse({
      comp_id: 1,
      transcript: { text: WORDS_JSON },
      highlight: { color: [1, 0.8, 0] },
      expect: expectArg,
    });
  const plan = planCaptions(args());

  it("guards, reads, writes with the finished captions, and reads back in a separate call", async () => {
    const a = args();
    const before = readOf([]);
    const after = readOf(
      plan.captions.map((c, i) => rc(i + 1, `Caption 00${i + 1}`, c.lines.join("\r"), c.start, c.end, { highlight: { present: true, start_keys: c.words.length } }))
    );
    const { ctx, calls } = fakeAe({
      captionsRead: [before, after],
      captionsApply: [
        {
          created: ["Caption 001", "Caption 002"],
          updated: [],
          removed: [],
          timings: plan.captions.map((c) => [c.start, c.end]),
          highlight_keys: 6,
          boxes: 0,
          font_size: 65,
          safe: {},
          warnings: [],
        },
      ],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "captionsRead", "captionsApply", "captionsRead"]);
    const sent = calls[2].script;
    expect(sent).toContain('"expect"');
    expect(sent).toContain('"words":[{"start":0.4}');
    expect(sent).toContain('"remove_stale":true');
    expect(sent).toContain('"9:16"');
    expect(out.receipt.matches).toBe(true);
    expect(out.count).toBe(2);
    expect(out.created).toEqual(["Caption 001", "Caption 002"]);
    expect(out.outside_safe).toEqual([]);
    expect(out.estimated_word_times).toBe(false);
  });

  it("lists captions outside the safe area and reports a failed read-back in the receipt instead of throwing", async () => {
    const a = AeCaptionsSchema.parse({ comp_id: 1, transcript: { text: WORDS_JSON }, expect: expectArg });
    const wide = readOf(
      plan.captions.map((c, i) => rc(i + 1, `Caption 00${i + 1}`, c.lines.join("\r"), c.start, c.end, { outside_safe: i === 0, rect: { left: -600, top: -60, width: 1200, height: 70 } }))
    );
    const ok = fakeAe({
      captionsRead: [readOf([]), wide],
      captionsApply: [{ created: [], updated: [], removed: [], timings: plan.captions.map((c) => [c.start, c.end]), warnings: [] }],
    });
    const out = await tool("ae_captions").handler(a, ok.ctx);
    expect(out.outside_safe).toEqual([{ name: "Caption 001", width: 1200 }]);
    expect(out.warnings.join(" ")).toMatch(/outside the safe area/);

    // The read after the write throws: the write stands, the receipt says so.
    const results = { captionsRead: [readOf([])], captionsApply: [{ created: ["Caption 001"], timings: [], warnings: [] }] };
    const failing = fakeAe(results);
    const out2 = await tool("ae_captions").handler(a, failing.ctx);
    expect(out2.applied).toBe(true);
    expect(out2.receipt.matches).toBe(false);
    expect(JSON.stringify(out2.receipt)).toMatch(/Do not resend/);
  });

  it("returns bad_transcript before touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    const out = await tool("ae_captions").handler(AeCaptionsSchema.parse({ comp_id: 1, transcript: { text: "nothing" }, expect: expectArg }), ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_transcript" });
    expect(calls).toEqual([]);
  });

  it("ae_captions_read calls the host read with the margins and the default table", async () => {
    const { ctx, calls } = fakeAe({ captionsRead: [readOf([])] });
    const out = await tool("ae_captions_read").handler(AeCaptionsReadSchema.parse({ comp_id: 1, layout: { margins: { bottom: 0.3 } } }), ctx);
    expect(out.total_captions).toBe(0);
    expect(calls[0].script).toContain('"name_prefix":"Caption"');
    expect(calls[0].script).toContain('"bottom":0.3');
    expect(Object.keys(DEFAULT_MARGINS).every((k) => calls[0].script.includes(`"${k}"`))).toBe(true);
  });
});

// ---------- the host functions under node:vm ----------

const origAdd = FakeGroup.prototype.addProperty;
const origSet = FakeProperty.prototype.setValueAtTime;
const origSetValue = FakeProperty.prototype.setValue;

/** AE copies a TextDocument on the way in; the fake keeps the reference, so the host's reused document would alias every key. */
const copyDoc = (v: unknown) => (v instanceof TextDocument ? Object.assign(new TextDocument(v.text), v) : v);

beforeAll(() => {
  // The fake's range selector has the Percentage properties only; AE adds Index Start/End beside them.
  (FakeGroup.prototype as any).addProperty = function (this: FakeGroup, matchName: string) {
    const made = origAdd.call(this, matchName) as FakeGroup;
    if (matchName === "ADBE Text Selector") {
      for (const [name, mn] of [["Start", "ADBE Text Index Start"], ["End", "ADBE Text Index End"]]) {
        const p = new FakeProperty(name, mn, PropertyValueType.OneD, 0);
        p.parentProperty = made;
        made.props.splice(3, 0, p);
      }
    }
    return made;
  };
  (FakeProperty.prototype as any).setValueAtTime = function (this: FakeProperty, t: number, v: unknown) {
    return origSet.call(this, t, copyDoc(v));
  };
  (FakeProperty.prototype as any).setValue = function (this: FakeProperty, v: unknown) {
    return origSetValue.call(this, copyDoc(v));
  };
});
afterAll(() => {
  FakeGroup.prototype.addProperty = origAdd;
  FakeProperty.prototype.setValueAtTime = origSet;
  FakeProperty.prototype.setValue = origSetValue;
});

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Vertical", 1080, 1920, 20);
  comp.frameRate = 25;
  const host = loadHost(project, ["captions.jsx"]);
  host.G.ParagraphJustification = { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7414, RIGHT_JUSTIFY: 7415 };
  return { project, comp, ...host };
}

const cap = (start: number, end: number, lines: string[], wordStarts?: number[]) => ({
  start,
  end,
  lines,
  ...(wordStarts ? { words: wordStarts.map((s) => ({ start: s })) } : {}),
});

const CAPS = [cap(0.4, 2, ["Hello there"], [0.4, 1.2]), cap(3.2, 4.4, ["Second", "caption here"], [3.2, 3.8, 4.0])];

const apply = (A: any, comp: FakeComp, extra: Record<string, unknown> = {}) =>
  A.captionsApply({
    comp_id: comp.id,
    mode: "layers",
    name_prefix: "Caption",
    first_number: 1,
    captions: CAPS,
    default_margins: DEFAULT_MARGINS,
    expect: GUARD,
    ...extra,
  });

const kv = (p: FakeProperty) => p.keys.map((k) => [Math.round(k.time * 1e6) / 1e6, k.value]);
const names = (c: FakeComp) => c.stack.map((l) => l.name);
const doc = (l: FakeLayer) => ((l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).value as TextDocument;
const srcProp = (l: FakeLayer) => (l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty;
const pos = (l: FakeLayer) => (l.transform("Position").value as number[]).slice(0, 2);

function animatorOf(l: FakeLayer) {
  const anim = ((l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup).property(1) as FakeGroup;
  const sel = (anim.property("ADBE Text Selectors") as FakeGroup).property(1) as FakeGroup;
  return {
    anim,
    fill: (anim.property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Fill Color") as FakeProperty,
    start: sel.property("ADBE Text Index Start") as FakeProperty,
    end: sel.property("ADBE Text Index End") as FakeProperty,
    units: (sel.property("ADBE Text Range Advanced") as FakeGroup).property("ADBE Text Range Units") as FakeProperty,
    basedOn: (sel.property("ADBE Text Range Advanced") as FakeGroup).property("ADBE Text Range Type2") as FakeProperty,
  };
}

describe("captions.jsx: layers mode", () => {
  it("creates one named text layer per caption, timed, styled and placed in the 9:16 safe area", () => {
    const { comp, A, undo } = scene();
    const out = apply(A, comp);
    expect(out.created).toEqual(["Caption 001", "Caption 002"]);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    const one = comp.layer("Caption 001")!;
    const two = comp.layer("Caption 002")!;
    expect(doc(one).text).toBe("Hello there");
    expect(doc(two).text).toBe("Second\rcaption here");
    expect(one.inPoint).toBeCloseTo(0.4, 6);
    expect(one.outPoint).toBeCloseTo(2, 6);
    expect(two.inPoint).toBeCloseTo(3.2, 6);
    expect(doc(one).fontSize).toBe(65);
    expect((doc(one) as any).justification).toBe(7414);
    // 1920 x 0.8 = 1536 is the bottom of the safe area; one line sits a quarter-size above it, two lines a line-height higher.
    expect(pos(one)[0]).toBe(540);
    expect(pos(one)[1]).toBeCloseTo(1536 - 65 * 0.25, 6);
    expect(pos(two)[1]).toBeCloseTo(1536 - 65 * 0.25 - 65 * 1.2, 6);
    expect(out.timings).toEqual([[0.4, 2], [3.2, 4.4]].map(([s, e]) => [expect.closeTo(s, 6), expect.closeTo(e, 6)]));
  });

  it("applies the style, stroke, justification and a custom position and margin", () => {
    const { comp, A } = scene();
    apply(A, comp, {
      style: { font: "Arial-BoldMT", font_size: 80, fill_color: [1, 1, 0], stroke_color: [0, 0, 0], justification: "left" },
      layout: { position: "top", margins: { left: 0.1, top: 0.2 } },
    });
    const d = doc(comp.layer("Caption 001")!) as any;
    expect(d.font).toBe("Arial-BoldMT");
    expect(d.fontSize).toBe(80);
    expect(d.fillColor).toEqual([1, 1, 0]);
    expect(d.applyStroke).toBe(true);
    expect(d.strokeWidth).toBe(7);
    expect(d.justification).toBe(7413);
    expect(pos(comp.layer("Caption 001")!)).toEqual([108, 384 + 64]);
  });

  it("makes paragraph text with a box in the safe area", () => {
    const { comp, A } = scene();
    apply(A, comp, { style: { font_size: 60, text_box: { width: 800 } } });
    const l = comp.layer("Caption 001")!;
    // The fake's box layer reports its size as the layer rect.
    expect(l.rect.width).toBe(800);
    expect(l.rect.height).toBeCloseTo(72, 6);
    expect(pos(l)).toEqual([140, 1536 - 72]);
  });

  it("updates by name: text and timing change, the user's position stays, stale layers go", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const one = comp.layer("Caption 001")!;
    one.transform("Position").setValue([300, 500]);
    const idBefore = one.id;
    const out = apply(A, comp, { captions: [cap(1, 2.4, ["Edited line"])] });
    expect(out.updated).toEqual(["Caption 001"]);
    expect(out.created).toEqual([]);
    expect(out.removed).toEqual(["Caption 002"]);
    expect(names(comp)).toEqual(["Caption 001"]);
    const same = comp.layer("Caption 001")!;
    expect(same.id).toBe(idBefore);
    expect(doc(same).text).toBe("Edited line");
    expect(same.inPoint).toBeCloseTo(1, 6);
    expect(same.outPoint).toBeCloseTo(2.4, 6);
    expect(pos(same)).toEqual([300, 500]);
    // restyle puts it back where the layout says.
    apply(A, comp, { captions: [cap(1, 2.4, ["Edited line"])], restyle: true });
    expect(pos(comp.layer("Caption 001")!)[0]).toBe(540);
  });

  it("keeps stale layers when remove_stale is false and numbers from first_number", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const out = apply(A, comp, { captions: [cap(5, 6, ["Later"])], first_number: 3, remove_stale: false });
    expect(out.created).toEqual(["Caption 003"]);
    expect(out.removed).toEqual([]);
    expect(names(comp).sort()).toEqual(["Caption 001", "Caption 002", "Caption 003"]);
  });

  it("moves a layer's span without tripping on the old out point", () => {
    const { comp, A } = scene();
    apply(A, comp, { captions: [cap(0.4, 1, ["Early"])] });
    apply(A, comp, { captions: [cap(10, 11, ["Late"])] });
    const l = comp.layer("Caption 001")!;
    expect(l.inPoint).toBeCloseTo(10, 6);
    expect(l.outPoint).toBeCloseTo(11, 6);
  });

  it("keys a word highlight in Index units, Based On Words, held", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { highlight: { color: [1, 0.8, 0] } });
    // Caption 1: two words, caption 2: three words.
    expect(out.highlight_keys).toBe(5);
    const a = animatorOf(comp.layer("Caption 001")!);
    expect(a.anim.name).toBe("Caption Highlight");
    expect(a.fill.staticValue).toEqual([1, 0.8, 0]);
    expect(a.units.staticValue).toBe(2);
    expect(a.basedOn.staticValue).toBe(3);
    expect(kv(a.start)).toEqual([[0.4, 0], [1.2, 1]]);
    expect(kv(a.end)).toEqual([[0.4, 1], [1.2, 2]]);
    expect(a.start.keys.every((k) => k.outI === 6614)).toBe(true);
    const b = animatorOf(comp.layer("Caption 002")!);
    expect(b.start.keys.map((k) => k.value)).toEqual([0, 1, 2]);
    // A re-run re-keys the same animator rather than adding a second.
    apply(A, comp, { highlight: { color: [1, 0, 0] } });
    const anims = (comp.layer("Caption 001")!.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup;
    expect(anims.numProperties).toBe(1);
    expect(animatorOf(comp.layer("Caption 001")!).start.numKeys).toBe(2);
  });

  it("starts the selection at a clean zero when the first word comes after the caption starts", () => {
    const { comp, A } = scene();
    apply(A, comp, { captions: [cap(1, 3, ["Late word"], [1.4, 2])], highlight: { color: [1, 0, 0] } });
    const a = animatorOf(comp.layer("Caption 001")!);
    expect(kv(a.start)).toEqual([[1, 0], [1.4, 0], [2, 1]]);
    expect(kv(a.end)).toEqual([[1, 0], [1.4, 1], [2, 2]]);
  });

  it("adds a background box under the text that follows it by expression", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { box: { color: [0, 0, 0], opacity: 60, padding: 24, roundness: 8 } });
    expect(out.boxes).toBe(2);
    expect(out.created).toEqual(["Caption 001", "Caption 001 Box", "Caption 002", "Caption 002 Box"]);
    const text = comp.layer("Caption 001")!;
    const box = comp.layer("Caption 001 Box")!;
    expect(box.index).toBe(text.index + 1);
    expect(box.inPoint).toBeCloseTo(0.4, 6);
    expect(box.outPoint).toBeCloseTo(2, 6);
    const rect = (((box.property("ADBE Root Vectors Group") as FakeGroup).property(1) as FakeGroup).property("ADBE Vectors Group") as FakeGroup).property("ADBE Vector Shape - Rect") as FakeGroup;
    const size = (rect.property("ADBE Vector Rect Size") as FakeProperty).expression;
    expect(size).toContain('thisComp.layer("Caption 001")');
    expect(size).toContain("sourceRectAtTime(time, false)");
    expect(size).toContain("r.width + 48");
    expect((rect.property("ADBE Vector Rect Position") as FakeProperty).expression).toContain("t.toComp(");
    expect((rect.property("ADBE Vector Rect Roundness") as FakeProperty).staticValue).toBe(8);
    expect(box.transform("Opacity").expression).toContain("o = 60");
    // The box is reused on a re-run, not duplicated.
    const again = apply(A, comp, { box: { color: [0, 0, 0], opacity: 60, padding: 24, roundness: 8 } });
    expect(again.created).toEqual([]);
    expect(comp.stack.filter((l) => l.name === "Caption 001 Box")).toHaveLength(1);
  });
});

describe("captions.jsx: single mode", () => {
  it("hold-keys the Source Text per caption with a blank key in each gap", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { mode: "single" });
    expect(out.created).toEqual(["Caption"]);
    expect(names(comp)).toEqual(["Caption"]);
    const l = comp.layer("Caption")!;
    const p = srcProp(l);
    expect(p.keys.map((k) => [k.time, (k.value as TextDocument).text])).toEqual([
      [0.4, "Hello there"],
      [2, ""],
      [3.2, "Second\rcaption here"],
      [4.4, ""],
    ]);
    expect(l.inPoint).toBeCloseTo(0.4, 6);
    expect(l.outPoint).toBeCloseTo(4.4, 6);
    // Placed for the tallest caption (two lines).
    expect(pos(l)[1]).toBeCloseTo(1536 - 65 * 0.25 - 65 * 1.2, 6);
  });

  it("leaves no blank key between captions that touch", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "single", captions: [cap(0, 1, ["A"]), cap(1, 2, ["B"])] });
    expect(srcProp(comp.layer("Caption")!).keys.map((k) => (k.value as TextDocument).text)).toEqual(["A", "B", ""]);
  });

  it("re-keys the same layer on a re-run", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "single" });
    const id = comp.layer("Caption")!.id;
    apply(A, comp, { mode: "single", captions: [cap(1, 2, ["Only"])] });
    expect(comp.layer("Caption")!.id).toBe(id);
    expect(srcProp(comp.layer("Caption")!).keys.map((k) => (k.value as TextDocument).text)).toEqual(["Only", ""]);
  });

  it("restarts the word index at each caption and clears the selection at its end", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { mode: "single", highlight: { color: [1, 0, 0] } });
    const a = animatorOf(comp.layer("Caption")!);
    expect(kv(a.start)).toEqual([
      [0.4, 0],
      [1.2, 1],
      [2, 0],
      [3.2, 0],
      [3.8, 1],
      [4, 2],
      [4.4, 0],
    ]);
    expect(a.end.keys.map((k) => k.value)).toEqual([1, 2, 0, 1, 2, 3, 0]);
    expect(out.highlight_keys).toBe(7);
  });
});

describe("captions.jsx: refusals and cleanup", () => {
  it("refuses a bad request before the undo group opens and before anything is added", () => {
    const { comp, A, undo } = scene();
    const kind = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { __kind?: string }).__kind;
      }
      return "no error";
    };
    expect(kind(() => apply(A, comp, { expect: { project_path: "C:/other.aep" } }))).toBe("guard");
    expect(kind(() => apply(A, comp, { captions: [cap(25, 26, ["Past the end"])] }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { captions: [cap(-1, 1, ["Before zero"])] }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { captions: [cap(1, 2, [])] }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { captions: [cap(2, 3, ["B"]), cap(0, 1, ["A"])] }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { style: { fill_color: [2, 0, 0] } }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { style: { font_size: 5000 } }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { style: { justification: "full" } }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { layout: { position: "nowhere" } }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { box: { color: [0, 0, 0], opacity: 500, padding: 1, roundness: 0 } }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { mode: "grid" }))).toBe("bad_args");
    // One word time short of the words.
    expect(kind(() => apply(A, comp, { highlight: { color: [1, 0, 0] }, captions: [cap(1, 2, ["two words"], [1])] }))).toBe("bad_args");
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("refuses two layers with a caption's name, a non-text layer in its place, and keyed Source Text", () => {
    const { comp, A, undo } = scene();
    comp.layers.addText("x").name = "Caption 001";
    comp.layers.addText("y").name = "Caption 001";
    expect(() => apply(A, comp)).toThrow(/Two layers answer to caption 1/);
    comp.layer(1)!.remove();
    comp.layer(1)!.remove();

    comp.layers.addSolid([0, 0, 0], "Caption 001", 10, 10, 1, 1);
    expect(() => apply(A, comp)).toThrow(/not a text layer/);
    comp.layer(1)!.remove();

    const keyed = comp.layers.addText("keyed");
    keyed.name = "Caption 001";
    srcProp(keyed).setValueAtTime(0, doc(keyed));
    expect(() => apply(A, comp)).toThrow(/Source Text keyframes/);
    expect(undo.begun).toBe(0);
  });

  it("takes back the layers it added when a step fails, and still closes the undo group", () => {
    const { comp, A, undo } = scene();
    const real = comp.layers.addText;
    let n = 0;
    comp.layers.addText = (text: string) => {
      if (++n === 2) throw new Error("AE refused the second layer");
      return real(text);
    };
    expect(() => apply(A, comp)).toThrow(/refused the second layer/);
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });
});

describe("captions.jsx: captionsRead", () => {
  it("reads captions, key counts, the highlight and the safe-area check without changing anything", () => {
    const { comp, A, undo } = scene();
    apply(A, comp, { highlight: { color: [1, 0, 0] }, box: { color: [0, 0, 0], opacity: 60, padding: 24, roundness: 0 } });
    // Make the first caption wider than the 952 px of safe width.
    comp.layer("Caption 001")!.rect = { left: -600, top: -60, width: 1200, height: 70 };
    comp.layer("Caption 002")!.rect = { left: -200, top: -60, width: 400, height: 70 };
    const begun = undo.begun;
    const stackBefore = names(comp);
    const r = A.captionsRead({ comp_id: comp.id, mode: "layers", name_prefix: "Caption", default_margins: DEFAULT_MARGINS });
    expect(undo.begun).toBe(begun);
    expect(names(comp)).toEqual(stackBefore);
    expect(r.safe.width).toBeCloseTo(1080 * 0.88, 6);
    expect(r.safe.bottom).toBeCloseTo(384, 6);
    expect(r.total_captions).toBe(2);
    expect(r.truncated).toBe(false);
    const [one, two] = r.captions;
    expect(one).toMatchObject({ number: 1, name: "Caption 001", kind: "text", text: "Hello there", justification: "center", numKeys: 0 });
    expect(one.highlight).toMatchObject({ present: true, start_keys: 2, end_keys: 2, units: 2, based_on: 3 });
    expect(one.outside_safe).toBe(true);
    expect(two.outside_safe).toBe(false);
    expect(r.boxes.map((b: { name: string }) => b.name)).toEqual(["Caption 001 Box", "Caption 002 Box"]);
    expect(r.boxes[0].expression_errors).toEqual([]);
  });

  it("reads a single layer's keys and the first one outside the safe area", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "single" });
    comp.layer("Caption")!.rect = { left: 0, top: -60, width: 2000, height: 70 };
    const r = A.captionsRead({ comp_id: comp.id, mode: "single", name_prefix: "Caption", default_margins: DEFAULT_MARGINS });
    const entry = r.captions[0];
    expect(entry.numKeys).toBe(4);
    expect(entry.keys.map((k: { text: string }) => k.text)).toEqual(["Hello there", "", "Second\rcaption here", ""]);
    expect(entry.keys[0].outside_safe).toBe(true);
    expect(entry.keys[1].outside_safe).toBeUndefined();
    expect(entry.first_outside_safe).toBeCloseTo(0.4, 6);
  });

  it("uses the override margins and finds nothing for another prefix", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const r = A.captionsRead({ comp_id: comp.id, mode: "layers", name_prefix: "Lyrics", layout: { margins: { bottom: 0.5 } }, default_margins: DEFAULT_MARGINS });
    expect(r.captions).toEqual([]);
    expect(r.safe.bottom).toBe(960);
  });
});

// ---------- review fixes ----------

describe("captionsMismatches: continuation calls", () => {
  const caps: Caption[] = [{ start: 1, end: 2, lines: ["Later"], words: [{ text: "Later", start: 1, end: 2 }] }];
  const written = { timings: [[1, 2]] as Array<[number, number]>, created: ["Caption 101"], highlight_keys: 1 };
  const args = { mode: "layers" as const, first_number: 101, highlight: { color: [1, 1, 0] }, box: undefined, style: undefined };

  it("counts only the highlights of the layers this call keyed", () => {
    const after = readOf([
      rc(1, "Caption 001", "old", 0, 1, { highlight: { present: true, start_keys: 7 } }),
      rc(101, "Caption 101", "Later", 1, 2, { highlight: { present: true, start_keys: 1 } }),
    ]);
    expect(captionsMismatches(args, false, caps, after, written)).toEqual([]);
  });

  it("does not call earlier chunks stale and uses beyond_count when the read has a range", () => {
    const after = readOf([rc(101, "Caption 101", "Later", 1, 2, { highlight: { present: true, start_keys: 1 } })]);
    expect(captionsMismatches(args, true, caps, after, written)).toEqual([]);
    const above = { ...after!, beyond_count: 2 };
    expect(captionsMismatches(args, true, caps, above, written).map((x) => x.path)).toContain("stale");
  });

  it("flags a highlight left on a caption when none was asked for", () => {
    const after = readOf([rc(1, "Caption 001", "Later", 1, 2, { highlight: { present: true, start_keys: 3 } })]);
    const none = { ...args, first_number: undefined, highlight: undefined };
    expect(captionsMismatches(none, true, caps, after, { ...written, created: [] }).map((x) => x.path)).toContain("highlight.stale");
  });
});

describe("ae_captions flow: continuation and failed read-back", () => {
  it("asks both reads for the numbers it writes", async () => {
    const a = AeCaptionsSchema.parse({ comp_id: 1, transcript: { text: WORDS_JSON }, first_number: 501, expect: expectArg });
    const plan = planCaptions(a);
    const after = readOf(plan.captions.map((c, i) => rc(501 + i, `Caption ${501 + i}`, c.lines.join("\r"), c.start, c.end)));
    const { ctx, calls } = fakeAe({
      captionsRead: [readOf([]), after],
      captionsApply: [{ created: [], timings: plan.captions.map((c) => [c.start, c.end]), warnings: [] }],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    for (const i of [1, 3]) {
      expect(calls[i].script).toContain('"from_number":501');
      expect(calls[i].script).toContain('"to_number":502');
    }
    expect(calls[2].script).toContain('"remove_stale":false');
    expect(out.receipt.matches).toBe(true);
  });

  it("keeps the plan's warnings and the estimate when the read-back fails", async () => {
    const a = AeCaptionsSchema.parse({ comp_id: 1, transcript: { text: SRT, format: "srt" }, expect: expectArg });
    const plan = planCaptions(a);
    const { ctx } = fakeAe({ captionsRead: [readOf([])], captionsApply: [{ created: ["Caption 001"], timings: [], warnings: ["host warning"] }] });
    const out = await tool("ae_captions").handler(a, ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.estimated_word_times).toBe(true);
    expect(out.warnings).toEqual([...plan.warnings, "host warning"]);
  });

  it("ae_captions_read passes a number range and refuses an inverted one", async () => {
    const { ctx, calls } = fakeAe({ captionsRead: [readOf([])] });
    await tool("ae_captions_read").handler(AeCaptionsReadSchema.parse({ comp_id: 1, from_number: 501, to_number: 700 }), ctx);
    expect(calls[0].script).toContain('"from_number":501');
    expect(calls[0].script).toContain('"to_number":700');
    expect(AeCaptionsReadSchema.safeParse({ comp_id: 1, from_number: 9, to_number: 3 }).success).toBe(false);
  });
});

describe("captions.jsx: review fixes", () => {
  it("captionsRead pages by number and counts what lies above", () => {
    const { comp, A } = scene();
    apply(A, comp, { captions: [cap(0, 1, ["a"]), cap(1, 2, ["b"]), cap(2, 3, ["c"]), cap(3, 4, ["d"])] });
    const r = A.captionsRead({ comp_id: comp.id, mode: "layers", name_prefix: "Caption", from_number: 2, to_number: 3, default_margins: DEFAULT_MARGINS });
    expect(r.captions.map((c: { number: number }) => c.number)).toEqual([2, 3]);
    expect(r.total_captions).toBe(2);
    expect(r.beyond_count).toBe(1);
  });

  it("remove_stale removes only numbers past the new captions and names grow past 999 without a stray zero", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const out = apply(A, comp, { captions: [cap(5, 6, ["Later"])], first_number: 3, remove_stale: true });
    expect(out.removed).toEqual([]);
    expect(names(comp).sort()).toEqual(["Caption 001", "Caption 002", "Caption 003"]);
    const big = apply(A, comp, { captions: [cap(7, 8, ["x"])], first_number: 501, remove_stale: false });
    expect(big.created).toEqual(["Caption 501"]);
    const huge = apply(A, comp, { captions: [cap(9, 10, ["y"])], first_number: 1000, remove_stale: false });
    expect(huge.created).toEqual(["Caption 1000"]);
  });

  it("gates the box on the text layer's own span", () => {
    const { comp, A } = scene();
    apply(A, comp, { box: { color: [0, 0, 0], opacity: 60, padding: 24, roundness: 0 } });
    const expr = comp.layer("Caption 001 Box")!.transform("Opacity").expression;
    expect(expr).toContain("time >= t.inPoint && time < t.outPoint");
  });

  it("a re-run without box or highlight moves the old box and removes the old highlight", () => {
    const { comp, A } = scene();
    apply(A, comp, { highlight: { color: [1, 0, 0] }, box: { color: [0, 0, 0], opacity: 60, padding: 24, roundness: 0 } });
    const out = apply(A, comp, { captions: [cap(5, 6, ["Moved"]), cap(7, 8, ["Also"])] });
    const box = comp.layer("Caption 001 Box")!;
    expect(box.inPoint).toBeCloseTo(5, 6);
    expect(box.outPoint).toBeCloseTo(6, 6);
    const anims = (comp.layer("Caption 001")!.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup;
    expect(anims.numProperties).toBe(0);
    expect(out.warnings.join(" ")).toMatch(/removed the old Caption Highlight/);
    expect(out.warnings.join(" ")).toMatch(/from an earlier run/);
  });

  it("clamps word times that fall after the caption's end and says so", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { captions: [cap(1, 1.2, ["fast words here"], [1, 1.1, 1.5])], highlight: { color: [1, 0, 0] } });
    expect(out.warnings.join(" ")).toMatch(/fell after the caption's end/);
    const a = animatorOf(comp.layer("Caption 001")!);
    expect(a.start.keys.every((k) => k.time < 1.2)).toBe(true);
  });

  it("places paragraph text by boxTextPos when AE reports it", () => {
    const { comp, A } = scene();
    const real = comp.layers.addBoxText;
    comp.layers.addBoxText = (size: number[], text: string) => {
      const l = real(size, text);
      const d = srcProp(l).value as TextDocument & { boxTextPos?: number[] };
      d.boxTextPos = [-size[0] / 2, -size[1] / 2];
      srcProp(l).setValue(d);
      return l;
    };
    apply(A, comp, { style: { font_size: 60, text_box: { width: 800 } } });
    // Top-left wanted at [140, 1464]; the origin is half a box from it.
    expect(pos(comp.layer("Caption 001")!)).toEqual([140 + 400, 1464 + 36]);
  });

  it("single mode re-run keeps the first key's style", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "single", style: { font_size: 90 } });
    const p = srcProp(comp.layer("Caption")!);
    const out = apply(A, comp, { mode: "single", captions: [cap(1, 2, ["Again"])] });
    expect(out.updated).toEqual(["Caption"]);
    expect((p.keys[0].value as TextDocument).fontSize).toBe(90);
  });
});
