import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { PLATFORM_PRESET_IDS, PLATFORM_PRESETS } from "../src/motion-spec.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeCaptionsPlanSchema,
  AeCaptionsReadSchema,
  AeCaptionsSchema,
  CAPTION_DEFAULT_MARGINS,
  captionsMismatches,
  captionsTools,
  matchByTime,
  planCaptions,
  planFields,
  platformMargins,
  templateFieldValue,
  type CaptionsRead,
  type ReadCaption,
} from "../src/tools/ext/captions.js";
import type { Caption, CaptionPlan } from "../src/transcript.js";

// The tool side of the extra caption modes (words, template), the platform safe area, parent_to_null,
// precompose and match 'time': schema refusals, the arguments sent to the host and the receipt checks.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => captionsTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

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

const base = { comp_id: 1, transcript: { text: WORDS_JSON }, expect: expectArg };
const TEMPLATE = { comp_id: 9, fields: { "Line 1": "line1" as const, Name: "speaker" as const } };

// ---------- schemas ----------

describe("schemas of the extra modes", () => {
  it("accept words and template modes and the new options", () => {
    expect(AeCaptionsSchema.safeParse({ ...base, mode: "words" }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...base, mode: "template", template: TEMPLATE }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...base, parent_to_null: true, precompose: true, match: "time", platform: "tiktok_9_16" }).success).toBe(true);
    expect(AeCaptionsReadSchema.safeParse({ comp_id: 1, mode: "words", platform: "reels_9_16" }).success).toBe(true);
    expect(AeCaptionsReadSchema.safeParse({ comp_id: 1, mode: "template" }).success).toBe(true);
  });

  it("take the planner options on the plan and the write", () => {
    expect(AeCaptionsPlanSchema.safeParse({ transcript: { text: WORDS_JSON }, standard: "netflix_adult", cut_times: [1, 2], max_words: 4 }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...base, standard: "bbc", speaker_style: "color", single_word: true }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...base, standard: "nope" }).success).toBe(false);
    // The plan schema stays a plain object, so other tools can spread its shape.
    expect(Object.keys(AeCaptionsPlanSchema.shape)).toEqual(expect.arrayContaining(["transcript", "standard", "frame_rate"]));
  });

  it("refuse the combinations that make no sense, with a message that says why", () => {
    const msg = (v: Record<string, unknown>) => {
      const r = AeCaptionsSchema.safeParse({ ...base, ...v });
      return r.success ? "ok" : r.error.issues.map((i) => i.message).join(" | ");
    };
    expect(msg({ mode: "template" })).toMatch(/needs template/);
    expect(msg({ template: TEMPLATE })).toMatch(/applies to mode 'template' only/);
    expect(msg({ mode: "words", highlight: { color: [1, 1, 0] } })).toMatch(/highlight applies to layers and single mode/);
    expect(msg({ mode: "template", template: TEMPLATE, highlight: { color: [1, 1, 0] } })).toMatch(/highlight applies/);
    expect(msg({ mode: "words", box: { opacity: 50 } })).toMatch(/box applies to layers and single mode/);
    expect(msg({ mode: "single", match: "time" })).toMatch(/not single/);
    expect(msg({ mode: "single", first_number: 4 })).toMatch(/first_number applies/);
    expect(msg({ mode: "template", template: { comp_id: 9, fields: { X: "headline" } } })).not.toBe("ok");
    expect(msg({ platform: "snapchat" })).not.toBe("ok");
    expect(msg({ mode: "words", first_number: 5 })).toBe("ok");
  });

  it("the platform enum is the table in motion-spec", () => {
    for (const id of ["reels_9_16", "tiktok_9_16", "instagram_reels_9_16", "youtube_shorts_9_16"]) {
      expect(PLATFORM_PRESET_IDS).toContain(id);
      expect(AeCaptionsReadSchema.safeParse({ comp_id: 1, platform: id }).success).toBe(true);
    }
    // The 1080x1920 boxes of the brief: top, bottom, left, right in pixels.
    const px = (id: keyof typeof PLATFORM_PRESETS) => {
      const p = PLATFORM_PRESETS[id];
      return [p.top * 1920, p.bottom * 1920, p.left * 1080, p.right * 1080].map(Math.round);
    };
    expect(px("reels_9_16")).toEqual([288, 672, 120, 192]);
    expect(px("tiktok_9_16")).toEqual([240, 660, 120, 120]);
    expect(px("instagram_reels_9_16")).toEqual([269, 672, 65, 65]);
    expect(px("youtube_shorts_9_16")).toEqual([288, 672, 48, 192]);
    expect(PLATFORM_PRESETS.reels_9_16.label).toBe("9:16 safe on TikTok, Reels and Shorts (approximate)");
    // Other presets are kept.
    expect(PLATFORM_PRESET_IDS).toEqual(expect.arrayContaining(["promo_9_16", "feed_4_5", "square_1_1", "landscape_16_9", "title_safe"]));
  });

  it("a 9:16 caption default is the reels box, other table entries are ae_reframe's", () => {
    expect(CAPTION_DEFAULT_MARGINS["9:16"].bottom).toBeCloseTo(672 / 1920, 9);
    expect(CAPTION_DEFAULT_MARGINS["9:16"].right).toBeCloseTo(192 / 1080, 9);
    expect(CAPTION_DEFAULT_MARGINS["16:9"]).toEqual({ top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 });
  });
});

// ---------- pure helpers ----------

describe("matchByTime", () => {
  const ex = (id: number, number: number, inPoint: number, outPoint: number) => ({ id, number, inPoint, outPoint });

  it("pairs by the greatest overlap, one to one, in new-number order", () => {
    const out = matchByTime([ex(10, 1, 0.4, 2), ex(11, 2, 3.2, 4.4)], [
      { number: 1, start: 0, end: 0.3 },
      { number: 2, start: 0.4, end: 2.1 },
      { number: 3, start: 3.3, end: 4.4 },
    ]);
    expect(out).toEqual([
      { layer_id: 10, number: 2 },
      { layer_id: 11, number: 3 },
    ]);
  });

  it("leaves a layer with no overlap unmatched, and gives a contested caption to the bigger overlap", () => {
    // Two old layers overlap the one new caption; the longer overlap wins, the other is unmatched.
    const out = matchByTime([ex(1, 1, 0, 1), ex(2, 2, 1, 5)], [{ number: 1, start: 0.8, end: 5 }]);
    expect(out).toEqual([{ layer_id: 2, number: 1 }]);
    expect(matchByTime([ex(1, 1, 0, 1)], [{ number: 1, start: 1, end: 2 }])).toEqual([]);
    expect(matchByTime([], [{ number: 1, start: 0, end: 1 }])).toEqual([]);
  });

  it("breaks ties by the nearer start", () => {
    const out = matchByTime([ex(1, 1, 0, 2), ex(2, 2, 1, 3)], [{ number: 1, start: 1, end: 2 }]);
    expect(out).toEqual([{ layer_id: 2, number: 1 }]);
  });
});

describe("planFields", () => {
  it("carries the standard, bounded changes and violations with their counts, and the cleanup report", () => {
    const changes = Array.from({ length: 250 }, (_, n) => ({ n: n + 1, rule: "min_duration", action: "extended", detail: "x" }));
    const plan = { captions: [], warnings: [], estimated_word_times: false, standard: "bbc", changes, violations: [{ n: 1, rule: "cps", detail: "fast" }], cleanup: { dropped_short: 2 } } as unknown as CaptionPlan;
    const out = planFields(plan);
    expect(out.standard).toBe("bbc");
    expect((out.changes as unknown[]).length).toBe(200);
    expect(out).toMatchObject({ change_count: 250, violation_count: 1, lists_truncated: true, cleanup: { dropped_short: 2 } });
    const plain = planFields({ captions: [], warnings: [], estimated_word_times: false } as unknown as CaptionPlan);
    expect(plain).toMatchObject({ changes: [], violations: [], change_count: 0 });
    expect("standard" in plain).toBe(false);
  });

  it("ae_captions_plan returns the plan fields and the extras of each caption when set", async () => {
    const out = await tool("ae_captions_plan").handler(AeCaptionsPlanSchema.parse({ transcript: { text: WORDS_JSON }, frame_rate: 25 }), {} as ToolContext);
    expect(out.count).toBe(2);
    expect(out).toHaveProperty("changes");
    expect(out).toHaveProperty("violations");
  });
});

describe("templateFieldValue", () => {
  const c: Caption = { start: 0, end: 1, lines: ["Line a", "Line b"], words: [], speaker: "speaker_0" };
  it("splits the caption into the fields a template takes", () => {
    expect(templateFieldValue("line1", c)).toBe("Line a");
    expect(templateFieldValue("line2", c)).toBe("Line b");
    expect(templateFieldValue("line3", c)).toBe("");
    expect(templateFieldValue("text", c)).toBe("Line a\rLine b");
    expect(templateFieldValue("speaker", c)).toBe("speaker_0");
    expect(templateFieldValue("speaker", c, { speaker_0: "ANNA" })).toBe("ANNA");
    expect(templateFieldValue("speaker", { ...c, speaker: undefined })).toBe("");
  });
});

// ---------- receipt checks for the new modes ----------

const entry = (n: number, extra: Partial<ReadCaption>): ReadCaption => ({
  number: n,
  name: `Caption 00${n}`,
  id: 100 + n,
  index: n,
  kind: "text",
  inPoint: 0,
  outPoint: 1,
  ...extra,
});
const readOf = (captions: ReadCaption[], extra: Partial<CaptionsRead> = {}): CaptionsRead => ({
  comp_id: 1,
  width: 1080,
  height: 1920,
  frameDuration: 0.04,
  safe: { left: 120, right: 192, top: 288, bottom: 672, width: 768 },
  mode: "layers",
  captions,
  boxes: [],
  total_captions: captions.length,
  total_boxes: 0,
  truncated: false,
  ...extra,
});

describe("captionsMismatches for words and template", () => {
  const caps: Caption[] = [
    { start: 0.4, end: 2, lines: ["Hello", "there"], words: [{ text: "Hello", start: 0.4, end: 1 }, { text: "there", start: 1, end: 2 }], speaker: "speaker_0" },
    { start: 3.2, end: 4.4, lines: ["Second one"], words: [{ text: "Second", start: 3.2, end: 3.8 }, { text: "one", start: 3.8, end: 4.4 }] },
  ];
  const written = { timings: [[0.4, 2], [3.2, 4.4]] as Array<[number, number]>, created: [] as string[] };
  const common = { first_number: undefined, highlight: undefined, box: undefined, style: undefined };

  it("words: compares the joined text, the word layer count and the times", () => {
    const args = { ...common, mode: "words" as const };
    const good = readOf([
      entry(1, { kind: "words", text: "Hello there", word_layers: 2, inPoint: 0.4, outPoint: 2 }),
      entry(2, { kind: "words", text: "Second one", word_layers: 2, inPoint: 3.2, outPoint: 4.4 }),
    ], { mode: "words" });
    expect(captionsMismatches(args, true, caps, good, written)).toEqual([]);
    const bad = readOf([
      entry(1, { kind: "words", text: "Hello", word_layers: 1, inPoint: 0.4, outPoint: 2 }),
      entry(2, { kind: "words", text: "Second one", word_layers: 2, inPoint: 3.2, outPoint: 5 }),
      entry(3, { kind: "words", text: "old", word_layers: 1 }),
    ], { mode: "words" });
    const paths = captionsMismatches(args, true, caps, bad, written).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["captions[1].text", "captions[1].word_layers", "captions[2].outPoint", "stale"]));
  });

  it("template: compares the instanced comp and each mapped Essential Property", () => {
    const args = { ...common, mode: "template" as const, template: { comp_id: 9, fields: { "Line 1": "line1" as const, "Line 2": "line2" as const, Name: "speaker" as const } }, speaker_names: { speaker_0: "ANNA" } };
    const inst = (n: number, essential: Record<string, unknown>, sourceId = 9) => entry(n, { kind: "template", source_comp_id: sourceId, essential, inPoint: n === 1 ? 0.4 : 3.2, outPoint: n === 1 ? 2 : 4.4 });
    const good = readOf([inst(1, { "Line 1": "Hello", "Line 2": "there", Name: "ANNA" }), inst(2, { "Line 1": "Second one", "Line 2": "", Name: "" })], { mode: "template" });
    expect(captionsMismatches(args, true, caps, good, written)).toEqual([]);
    const bad = readOf([inst(1, { "Line 1": "Hello", "Line 2": "there", Name: "speaker_0" }), inst(2, { "Line 1": "Second one", "Line 2": "" }, 4)], { mode: "template" });
    const paths = captionsMismatches(args, true, caps, bad, written).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["captions[1].essential.Name", "captions[2].template", "captions[2].essential.Name"]));
  });
});

// ---------- the guarded flow with a fake bridge ----------

/** The comp frame rate the fake answers the frame-rate probe with. */
let fakeFps = 25;

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-captions-modes-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      if (script.includes('"frame_rate_probe":true')) return { ok: true, result: { frameDuration: 1 / fakeFps }, durationMs: 1 };
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

const applyArgs = (calls: Array<{ fn: string; script: string }>) => {
  const script = calls.find((c) => c.fn === "captionsApply")!.script;
  return JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
};
const readArgsOf = (calls: Array<{ fn: string; script: string }>, nth = 0) => {
  const script = calls.filter((c) => c.fn === "captionsRead")[nth].script;
  return JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
};

describe("ae_captions flow: modes and options", () => {
  const plan = planCaptions({ transcript: { text: WORDS_JSON }, frame_rate: 25 });
  const timings = plan.captions.map((c) => [c.start, c.end]);
  const goodLayers = (comp = 1) => readOf(plan.captions.map((c, i) => entry(i + 1, { text: c.lines.join("\r"), inPoint: c.start, outPoint: c.end, justification: "center" })), { comp_id: comp });

  it("words mode sends one start per word and passes its receipt", async () => {
    const a = AeCaptionsSchema.parse({ ...base, mode: "words" });
    const after = readOf(
      plan.captions.map((c, i) => entry(i + 1, { kind: "words", text: c.lines.join(" "), word_layers: c.words.length, inPoint: c.words[0].start, outPoint: c.end })),
      { mode: "words" }
    );
    const { ctx, calls } = fakeAe({
      captionsRead: [readOf([], { mode: "words" }), after],
      captionsApply: [{ created: [], updated: [], removed: [], timings: plan.captions.map((c) => [c.words[0].start, c.end]), word_layers: 6, warnings: [] }],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    const sent = applyArgs(calls);
    expect(sent.mode).toBe("words");
    // The time each word shows: the planner's lead-shifted show_at when it sets one, else the word's start.
    expect(sent.captions[0].words).toEqual(planCaptions({ ...a, frame_rate: 25 }).captions[0].words.map((w) => ({ start: (w as { show_at?: number }).show_at ?? w.start })));
    expect(sent.captions[0].words).toHaveLength(3);
    expect(out.receipt.matches).toBe(true);
    expect(out.word_layers).toBe(6);
  });

  it("template mode sends the template and the speaker, and the receipt reads the Essential Property values", async () => {
    const a = AeCaptionsSchema.parse({ ...base, mode: "template", template: { comp_id: 9, fields: { "Line 1": "line1" } } });
    const inst = plan.captions.map((c, i) => entry(i + 1, { kind: "template", source_comp_id: 9, essential: { "Line 1": c.lines[0] }, inPoint: c.start, outPoint: c.end }));
    const { ctx, calls } = fakeAe({
      captionsRead: [readOf([], { mode: "template" }), readOf(inst, { mode: "template" })],
      captionsApply: [{ created: ["Caption 001", "Caption 002"], timings, template: { comp_id: 9, name: "Lower Third", fields: 1 }, warnings: [] }],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    const sent = applyArgs(calls);
    expect(sent.template).toEqual({ comp_id: 9, fields: { "Line 1": "line1" } });
    expect(sent.captions[0]).not.toHaveProperty("words");
    expect(out.receipt.matches).toBe(true);
    expect(out.template).toMatchObject({ name: "Lower Third" });

    // A wrong value in the read-back shows in the receipt.
    const wrong = fakeAe({
      captionsRead: [readOf([], { mode: "template" }), readOf(inst.map((e) => ({ ...e, essential: { "Line 1": "other" } })), { mode: "template" })],
      captionsApply: [{ created: [], timings, warnings: [] }],
    });
    const bad = await tool("ae_captions").handler(a, wrong.ctx);
    expect(bad.receipt.matches).toBe(false);
    expect(JSON.stringify(bad.receipt.mismatches)).toMatch(/essential/);
  });

  it("a platform sets the host's margins and the rail check; no platform lets a 9:16 comp default to reels", async () => {
    const tiktok = fakeAe({ captionsRead: [readOf([]), goodLayers()], captionsApply: [{ created: [], timings, warnings: [] }] });
    await tool("ae_captions").handler(AeCaptionsSchema.parse({ ...base, platform: "tiktok_9_16" }), tiktok.ctx);
    const sent = applyArgs(tiktok.calls);
    expect(sent.platform_margins.top).toBeCloseTo(240 / 1920, 9);
    expect(sent.platform_margins.right).toBeCloseTo(120 / 1080, 9);
    expect(readArgsOf(tiktok.calls, 0).rail).toBe(true);
    expect(readArgsOf(tiktok.calls, 1).platform_margins.bottom).toBeCloseTo(660 / 1920, 9);

    const none = fakeAe({ captionsRead: [readOf([]), goodLayers()], captionsApply: [{ created: [], timings, warnings: [] }] });
    await tool("ae_captions").handler(AeCaptionsSchema.parse(base), none.ctx);
    const sentNone = applyArgs(none.calls);
    expect(sentNone).not.toHaveProperty("platform_margins");
    expect(sentNone.default_margins["9:16"].bottom).toBeCloseTo(672 / 1920, 9);
    expect(readArgsOf(none.calls, 0).rail).toBe("auto");

    const youtube = fakeAe({ captionsRead: [readOf([]), goodLayers()], captionsApply: [{ created: [], timings, warnings: [] }] });
    await tool("ae_captions").handler(AeCaptionsSchema.parse({ ...base, platform: "youtube_shorts_9_16" }), youtube.ctx);
    expect(readArgsOf(youtube.calls, 0).rail).toBe(false);
  });

  it("warns about captions in the action rail, and ae_captions_read passes the platform", async () => {
    const hit = readOf(plan.captions.map((c, i) => entry(i + 1, { text: c.lines.join("\r"), inPoint: c.start, outPoint: c.end, rail_overlap: i === 0 })));
    const { ctx } = fakeAe({ captionsRead: [readOf([]), hit], captionsApply: [{ created: [], timings, warnings: [] }] });
    const out = await tool("ae_captions").handler(AeCaptionsSchema.parse({ ...base, platform: "tiktok_9_16" }), ctx);
    expect(out.rail_overlap).toEqual(["Caption 001"]);
    expect(out.warnings.join(" ")).toMatch(/action rail/);
    expect(out.platform).toBe("tiktok_9_16");

    const read = fakeAe({ captionsRead: [readOf([])] });
    await tool("ae_captions_read").handler(AeCaptionsReadSchema.parse({ comp_id: 1, mode: "words", platform: "instagram_reels_9_16", layout: { margins: { top: 0.2 } } }), read.ctx);
    const sent = readArgsOf(read.calls);
    expect(sent.mode).toBe("words");
    expect(sent.platform_margins.left).toBeCloseTo(65 / 1080, 9);
    expect(sent.layout.margins.top).toBe(0.2);
    expect(sent.rail).toBe(false);
  });

  it("parent_to_null and precompose are sent, and the read-back follows the precomp", async () => {
    const a = AeCaptionsSchema.parse({ ...base, parent_to_null: true, precompose: true });
    const { ctx, calls } = fakeAe({
      captionsRead: [readOf([]), goodLayers(77)],
      captionsApply: [
        {
          created: ["Caption 001", "Caption 002", "Caption Control"],
          timings,
          target_comp_id: 77,
          precomp: { comp_id: 77, layer_id: 5, name: "Caption Captions", created: true },
          control: { name: "Caption Control", id: 4, created: true },
          warnings: [],
        },
      ],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    const sent = applyArgs(calls);
    expect(sent.parent_to_null).toBe(true);
    expect(sent.precompose).toBe(true);
    // The read before looks through an existing precomp; the read after goes straight to the comp the write named.
    expect(readArgsOf(calls, 0)).toMatchObject({ comp_id: 1, through_precomp: true });
    expect(readArgsOf(calls, 1)).toMatchObject({ comp_id: 77 });
    expect(readArgsOf(calls, 1)).not.toHaveProperty("through_precomp");
    expect(out.target_comp_id).toBe(77);
    expect(out.precomp).toMatchObject({ comp_id: 77, name: "Caption Captions" });
    expect(out.control).toMatchObject({ name: "Caption Control" });
    expect(out.receipt.matches).toBe(true);
  });

  it("match 'time' reads the layers first and sends the pairing", async () => {
    const existing = readOf([
      entry(1, { id: 501, inPoint: 0.4, outPoint: 2.04 }),
      entry(2, { id: 502, inPoint: 3.2, outPoint: 4.4 }),
      entry(3, { id: 503, inPoint: 9, outPoint: 10 }),
    ]);
    const a = AeCaptionsSchema.parse({ ...base, match: "time", remove_stale: true });
    const { ctx, calls } = fakeAe({
      captionsRead: [existing, readOf([]), goodLayers()],
      captionsApply: [{ created: [], updated: ["Caption 001", "Caption 002"], removed: ["Caption 003"], renamed: 0, timings, warnings: [] }],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["captionsRead", "checkGuard", "captionsRead", "captionsApply", "captionsRead"]);
    // The first read has no number range: it lists every layer the prefix finds.
    expect(readArgsOf(calls, 0)).not.toHaveProperty("from_number");
    expect(applyArgs(calls).mapping).toEqual([
      { layer_id: 501, number: 1 },
      { layer_id: 502, number: 2 },
    ]);
    expect(out.matched).toBe(2);
  });

  it("match 'time' refuses when more layers exist than a read lists", async () => {
    const capped = readOf([entry(1, { id: 501 })], { truncated: true, total_captions: 900 });
    const { ctx, calls } = fakeAe({ captionsRead: [capped] });
    const out = await tool("ae_captions").handler(AeCaptionsSchema.parse({ ...base, match: "time" }), ctx);
    expect(out).toMatchObject({ ok: false, error: "too_many_existing" });
    expect(calls.map((c) => c.fn)).toEqual(["captionsRead"]);
  });

  it("returns the plan's changes, violations and standard on the write result", async () => {
    const { ctx } = fakeAe({ captionsRead: [readOf([]), goodLayers()], captionsApply: [{ created: [], timings, warnings: [] }] });
    const out = await tool("ae_captions").handler(AeCaptionsSchema.parse({ ...base, standard: "netflix_adult" }), ctx);
    expect(out).toHaveProperty("changes");
    expect(out).toHaveProperty("violations");
    expect(out).toHaveProperty("change_count");
  });
});

// ---------- descriptions ----------

describe("descriptions", () => {
  it("name the modes, the options, the platform numbers' status and the refusals", () => {
    const d = tool("ae_captions").description;
    for (const word of ["words", "template", "parent_to_null", "precompose", "match 'time'", "platform", "approximate", "rail_overlap", "standard"]) expect(d).toContain(word);
    expect(tool("ae_captions_read").description).toMatch(/rail_overlap/);
    expect(tool("ae_captions_plan").description).toMatch(/changes/);
    expect(tool("ae_captions_plan").description).not.toMatch(/IMPORTANT/);
  });
});

// keep platformMargins in the public surface the tests rely on
describe("platformMargins", () => {
  it("gives the preset's four fractions", () => {
    expect(platformMargins("reels_9_16")).toEqual({ top: 288 / 1920, bottom: 672 / 1920, left: 120 / 1080, right: 192 / 1080 });
  });
});
