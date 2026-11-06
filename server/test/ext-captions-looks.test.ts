import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeCaptionsSchema, captionsMismatches, captionsTools, planCaptions, templateMismatches, type CaptionsRead, type ReadCaption } from "../src/tools/ext/captions.js";
import type { Caption } from "../src/transcript.js";

// The tool side of speaker colours, lyric italics, looks and make_template: schema refusals, the arguments sent
// to the host, and the receipt checks.

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
const msg = (v: Record<string, unknown>) => {
  const r = AeCaptionsSchema.safeParse({ ...base, ...v });
  return r.success ? "ok" : r.error.issues.map((i) => i.message).join(" | ");
};

describe("schema: look, look_options and make_template", () => {
  it("accepts the looks and their options", () => {
    for (const look of ["none", "pop", "pill_slide", "fill_sweep"]) expect(msg({ look })).toBe("ok");
    expect(msg({ mode: "words", look: "pop", look_options: { duration_frames: 8, scale_from: 70, color: [1, 1, 0], pill_padding: 10, pill_roundness: 20 } })).toBe("ok");
    expect(msg({ look: "pill_slide", highlight: { color: [1, 1, 0] }, box: { opacity: 50 } })).toBe("ok");
  });

  it("refuses a look with single or template mode, and fill_sweep with highlight", () => {
    expect(msg({ mode: "single", look: "pop" })).toMatch(/layers and words modes/);
    expect(msg({ mode: "template", template: { comp_id: 9, fields: { A: "text" } }, look: "pop" })).toMatch(/layers and words modes/);
    expect(msg({ look: "fill_sweep", highlight: { color: [1, 1, 0] } })).toMatch(/both colour the spoken words/);
    expect(msg({ mode: "single", look: "none" })).toBe("ok");
  });

  it("refuses bad options and look_options without a look", () => {
    expect(msg({ look: "pop", look_options: { duration_frames: 0 } })).not.toBe("ok");
    expect(msg({ look: "pop", look_options: { duration_frames: 31 } })).not.toBe("ok");
    expect(msg({ look: "pop", look_options: { scale_from: 201 } })).not.toBe("ok");
    expect(msg({ look: "fill_sweep", look_options: { color: [1, 1] } })).not.toBe("ok");
    expect(msg({ look: "pop", look_options: { nope: 1 } as never })).toBe("ok");
    expect(msg({ look_options: { duration_frames: 4 } })).toMatch(/need a look/);
    expect(msg({ look: "none", look_options: { duration_frames: 4 } })).toMatch(/need a look/);
    expect(msg({ look: "pill_slide", style: { text_box: {} } })).toMatch(/paragraph/);
    expect(msg({ look: "wobble" })).not.toBe("ok");
  });

  it("make_template needs no transcript, but a transcript needs one when it is not given", () => {
    const only = { comp_id: 1, expect: expectArg };
    expect(AeCaptionsSchema.safeParse({ ...only, make_template: {} }).success).toBe(true);
    expect(AeCaptionsSchema.safeParse({ ...only, make_template: { name: "T", width: 1920, height: 1080, duration_s: 6 }, look: "pop", box: {} }).success).toBe(true);
    const nothing = AeCaptionsSchema.safeParse(only);
    expect(nothing.success).toBe(false);
    expect(nothing.success ? "" : nothing.error.issues[0].message).toMatch(/Give a transcript/);
    expect(msg({ make_template: {} })).toMatch(/does not use a transcript/);
  });

  it("make_template refuses what a template cannot do", () => {
    const only = { comp_id: 1, expect: expectArg, make_template: {} };
    const m = (v: Record<string, unknown>) => {
      const r = AeCaptionsSchema.safeParse({ ...only, ...v });
      return r.success ? "ok" : r.error.issues.map((i) => i.message).join(" | ");
    };
    expect(m({ look: "pill_slide" })).toMatch(/none or pop/);
    expect(m({ look: "fill_sweep" })).toMatch(/none or pop/);
    expect(m({ mode: "words" })).toMatch(/make_template makes one template comp/);
    expect(m({ highlight: { color: [1, 1, 0] } })).toMatch(/make_template makes one template comp/);
    expect(m({ precompose: true })).toMatch(/make_template makes one template comp/);
    expect(m({ make_template: { width: 2 } })).not.toBe("ok");
    expect(m({ make_template: { duration_s: 0 } })).not.toBe("ok");
    expect(m({ look: "pop", look_options: { scale_from: 60 } })).toBe("ok");
  });
});

// ---------- receipt checks ----------

const entry = (n: number, extra: Partial<ReadCaption>): ReadCaption => ({ number: n, name: `Caption 00${n}`, id: 100 + n, index: n, kind: "text", inPoint: 0, outPoint: 1, ...extra });
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

describe("captionsMismatches: colour, italic and look", () => {
  const plan = planCaptions({ transcript: { text: WORDS_JSON }, frame_rate: 25 });
  const caps: Caption[] = plan.captions.map((c, i) => ({ ...c, ...(i === 0 ? { color: "#FF3333", kind: "speech" as const } : { italic: true, kind: "lyric" as const }) }));
  const timings = caps.map((c) => [c.start, c.end] as [number, number]);
  const written = { timings, created: [] as string[] };
  const common = { first_number: 1 } as const;
  const rows = (extra: Array<Partial<ReadCaption>>) => readOf(caps.map((c, i) => entry(i + 1, { text: c.lines.join("\r"), inPoint: c.start, outPoint: c.end, ...extra[i] })));

  it("passes when the fills and italics are what the plan says (tolerance 0.01)", () => {
    const after = rows([{ fill: [1, 0.2, 0.2], faux_italic: false }, { fill: [1, 1, 1], faux_italic: true }]);
    expect(captionsMismatches({ ...common }, true, caps, after, written)).toEqual([]);
  });

  it("flags a wrong fill and a wrong italic", () => {
    const after = rows([{ fill: [1, 1, 1], faux_italic: true }, { fill: [1, 0.2, 0.2], faux_italic: false }]);
    const paths = captionsMismatches({ ...common }, true, caps, after, written).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["captions[1].fill", "captions[1].faux_italic", "captions[2].fill", "captions[2].faux_italic"]));
  });

  it("uses style.fill_color for the captions without a colour", () => {
    const after = rows([{ fill: [1, 0.2, 0.2], faux_italic: false }, { fill: [1, 0.9, 0], faux_italic: true }]);
    expect(captionsMismatches({ ...common, style: { fill_color: [1, 0.9, 0] } }, true, caps, after, written)).toEqual([]);
  });

  it("does not check what the host did not report", () => {
    expect(captionsMismatches({ ...common }, true, caps, rows([{}, {}]), written)).toEqual([]);
  });

  it("words mode checks every word layer", () => {
    const wordCaps = plan.captions.map((c) => ({ ...c, color: "#FF3333" }));
    const mk = (fills: number[][]) => readOf(wordCaps.map((c, i) => entry(i + 1, { kind: "words", text: c.lines.join(" "), word_layers: c.words.length, inPoint: c.words[0].start, outPoint: c.end, words: fills.map((f, w) => ({ word: w + 1, name: "w", id: w, inPoint: 0, outPoint: 1, text: "x", fill: f })) })), { mode: "words" });
    const wr = { timings: wordCaps.map((c) => [c.words[0].start, c.end] as [number, number]) };
    const ok = mk([[1, 0.2, 0.2]]);
    ok.captions.forEach((e, i) => (e.word_layers = wordCaps[i].words.length));
    expect(captionsMismatches({ mode: "words", first_number: 1 }, true, wordCaps, ok, wr).filter((x) => x.path.endsWith(".fill"))).toEqual([]);
    const bad = mk([[1, 0.2, 0.2], [0, 0, 1]]);
    bad.captions.forEach((e, i) => (e.word_layers = wordCaps[i].words.length));
    expect(captionsMismatches({ mode: "words", first_number: 1 }, true, wordCaps, bad, wr).filter((x) => x.path.endsWith(".fill")).length).toBe(2);
  });

  it("single mode checks the fill of each text key", () => {
    const two: Caption[] = caps.map((c, i) => ({ ...c, start: i * 2, end: i * 2 + 1 }));
    const tm = two.map((c) => [c.start, c.end] as [number, number]);
    const keys = [
      { time: 0, text: two[0].lines.join("\r"), fill: [1, 0.2, 0.2], faux_italic: false },
      { time: 1, text: "" },
      { time: 2, text: two[1].lines.join("\r"), fill: [1, 0.2, 0.2], faux_italic: true },
      { time: 3, text: "" },
    ];
    const after = readOf([entry(1, { numKeys: 4, keys, inPoint: 0, outPoint: 3 })], { mode: "single" });
    const out = captionsMismatches({ mode: "single" }, true, two, after, { timings: tm });
    expect(out.map((x) => x.path)).toEqual(["caption.keys[2].fill"]);
  });

  it("look: present with the right kind passes; missing or another kind fails", () => {
    const ok = rows([{ look: { present: true, kind: "pop", keys: 4 } }, { look: { present: true, kind: "pop", keys: 6 } }]);
    expect(captionsMismatches({ ...common, look: "pop" }, true, caps, ok, { ...written, look: { kind: "pop", layers: 2, keys: 10, duration_frames: 6 } }).filter((x) => x.path.startsWith("look") || x.path.includes(".look"))).toEqual([]);
    const bad = rows([{ look: { present: false } }, { look: { present: true, kind: "fill_sweep", keys: 6 } }]);
    const paths = captionsMismatches({ ...common, look: "pop" }, true, caps, bad, { ...written, look: { kind: "pop", layers: 2, keys: 10, duration_frames: 6 } }).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["captions[1].look", "captions[2].look", "look.keys"]));
  });

  it("look none: a look left from an earlier run is a mismatch", () => {
    const left = rows([{ look: { present: true, kind: "pill_slide", keys: 3 } }, { look: { present: false } }]);
    expect(captionsMismatches({ ...common }, true, caps, left, written).map((x) => x.path)).toEqual(["captions[1].look"]);
    expect(captionsMismatches({ ...common, look: "none" }, true, caps, rows([{ look: { present: false } }, { look: { present: false } }]), written)).toEqual([]);
  });
});

describe("templateMismatches", () => {
  const good = {
    comp_id: 7,
    name: "T",
    controllers: ["Caption Text", "Caption Color", "Box Color", "Box Opacity"],
    layers: [
      { name: "Caption", id: 1, kind: "text", has_fill_effect: true, look: { present: true, kind: "pop" } },
      { name: "Caption Box", id: 2, kind: "shape" },
    ],
  };
  const w = { comp_id: 7, controllers_named: true };

  it("passes a template with all its controllers and layers", () => {
    expect(templateMismatches({ box: {}, look: "pop" }, good, w)).toEqual([]);
  });

  it("flags missing controllers, layers and pop keys", () => {
    const bad = { ...good, controllers: ["Caption Text"], layers: [{ name: "Caption", id: 1, kind: "text", has_fill_effect: false, look: { present: false } }] };
    const paths = templateMismatches({ box: {}, look: "pop" }, bad, w).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["template.controllers", "template.fill_effect", "template.look", "template.layers.Caption Box"]));
  });

  it("counts controllers when AE chose the names", () => {
    const aeNamed = { ...good, controllers: ["Source Text", "Color"], layers: [good.layers[0]] };
    expect(templateMismatches({ look: "none" }, aeNamed, { comp_id: 7, controllers_named: false })).toEqual([]);
    expect(templateMismatches({ box: {} }, aeNamed, { comp_id: 7, controllers_named: false }).map((x) => x.path)).toContain("template.controllers");
  });
});

// ---------- the guarded flow ----------

/** The comp frame rate the fake answers the frame-rate probe with. */
let fakeFps = 25;

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-captions-looks-"));
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
const argsOf = (calls: Array<{ fn: string; script: string }>, fn: string) => {
  const script = calls.find((c) => c.fn === fn)!.script;
  return JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
};

describe("ae_captions flow: colours, lyrics and looks", () => {
  const SPEAKER_JSON = JSON.stringify({
    words: [
      { text: "Hello", start: 0.4, end: 0.8, type: "word", speaker_id: "speaker_0" },
      { text: "there", start: 0.8, end: 1.2, type: "word", speaker_id: "speaker_0" },
      { text: "Second", start: 3.2, end: 3.6, type: "word", speaker_id: "speaker_1" },
      { text: "caption", start: 3.6, end: 4.0, type: "word", speaker_id: "speaker_1" },
    ],
  });

  it("sends each caption's colour as [r, g, b], and null for the ones without, when speaker_style is color", async () => {
    const a = AeCaptionsSchema.parse({ comp_id: 1, expect: expectArg, transcript: { text: SPEAKER_JSON }, speaker_style: "color", speaker_colors: ["#FF0000", "#0000FF"] });
    const plan = planCaptions(a);
    const { ctx, calls } = fakeAe({ captionsRead: [readOf([]), readOf([])], captionsApply: [{ created: [], timings: plan.captions.map((c) => [c.start, c.end]), warnings: [] }] });
    await tool("ae_captions").handler(a, ctx);
    const sent = argsOf(calls, "captionsApply");
    expect(sent.captions.length).toBe(plan.captions.length);
    const colours = sent.captions.map((c: { color?: number[] | null }) => c.color);
    expect(colours.some((c: unknown) => Array.isArray(c))).toBe(true);
    expect(colours).toContainEqual([1, 0, 0]);
    expect(colours).toContainEqual([0, 0, 1]);
    expect(sent.captions[0]).not.toHaveProperty("italic");
  });

  it("sends nothing about colour when the plan has none", async () => {
    const a = AeCaptionsSchema.parse(base);
    const plan = planCaptions(a);
    const { ctx, calls } = fakeAe({ captionsRead: [readOf([]), readOf([])], captionsApply: [{ created: [], timings: plan.captions.map((c) => [c.start, c.end]), warnings: [] }] });
    await tool("ae_captions").handler(a, ctx);
    const sent = argsOf(calls, "captionsApply");
    expect(sent.captions[0]).not.toHaveProperty("color");
    expect(sent).not.toHaveProperty("look");
    expect(sent.captions[0]).not.toHaveProperty("words");
  });

  it("sends lyric italics for every caption when any caption is a lyric", async () => {
    const a = AeCaptionsSchema.parse({ ...base, sdh: { lyric_ranges: [{ start: 3, end: 5 }] } });
    const plan = planCaptions(a);
    const lyric = plan.captions.filter((c) => (c as Caption).italic === true);
    const { ctx, calls } = fakeAe({ captionsRead: [readOf([]), readOf([])], captionsApply: [{ created: [], timings: plan.captions.map((c) => [c.start, c.end]), warnings: [] }] });
    await tool("ae_captions").handler(a, ctx);
    const sent = argsOf(calls, "captionsApply");
    if (lyric.length) {
      expect(sent.captions.map((c: { italic?: boolean }) => c.italic)).toEqual(plan.captions.map((c) => (c as Caption).italic === true));
      expect(sent.captions.some((c: { kind?: string }) => c.kind === "lyric")).toBe(true);
    }
  });

  it("a look sends the look, its options and a start and end for every word, and reports it", async () => {
    const a = AeCaptionsSchema.parse({ ...base, look: "fill_sweep", look_options: { color: [0, 1, 0] } });
    const plan = planCaptions(a);
    const after = readOf(plan.captions.map((c, i) => entry(i + 1, { text: c.lines.join("\r"), inPoint: c.start, outPoint: c.end, look: { present: true, kind: "fill_sweep", keys: 4 } })));
    const { ctx, calls } = fakeAe({
      captionsRead: [readOf([]), after],
      captionsApply: [{ created: [], timings: plan.captions.map((c) => [c.start, c.end]), look: { kind: "fill_sweep", layers: 2, keys: 8, duration_frames: 6 }, warnings: [] }],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    const sent = argsOf(calls, "captionsApply");
    expect(sent.look).toBe("fill_sweep");
    expect(sent.look_options).toEqual({ color: [0, 1, 0] });
    expect(sent.captions[0].words).toHaveLength(plan.captions[0].words.length);
    expect(sent.captions[0].words[0]).toEqual({ start: expect.any(Number), end: expect.any(Number) });
    expect(out.look).toEqual({ kind: "fill_sweep", layers: 2, keys: 8, duration_frames: 6 });
    expect(out.receipt.matches).toBe(true);
  });

  it("a look that is missing in the read-back fails the receipt", async () => {
    const a = AeCaptionsSchema.parse({ ...base, look: "pop" });
    const plan = planCaptions(a);
    const after = readOf(plan.captions.map((c, i) => entry(i + 1, { text: c.lines.join("\r"), inPoint: c.start, outPoint: c.end, look: { present: false } })));
    const { ctx } = fakeAe({ captionsRead: [readOf([]), after], captionsApply: [{ created: [], timings: plan.captions.map((c) => [c.start, c.end]), look: { kind: "pop", layers: 2, keys: 8, duration_frames: 6 }, warnings: [] }] });
    const out = await tool("ae_captions").handler(a, ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((x: { path: string }) => x.path)).toContain("captions[1].look");
  });
});

describe("ae_captions flow: make_template", () => {
  it("writes without a transcript, reads the new comp's controllers, and says what to do next", async () => {
    const a = AeCaptionsSchema.parse({ comp_id: 1, expect: expectArg, make_template: { name: "My Captions" }, box: { opacity: 50 }, look: "pop", style: { font_size: 70 } });
    const after = {
      comp_id: 42,
      name: "My Captions",
      controllers: ["Caption Text", "Caption Color", "Box Color", "Box Opacity"],
      layers: [
        { name: "Caption", id: 1, kind: "text", has_fill_effect: true, look: { present: true, kind: "pop" } },
        { name: "Caption Box", id: 2, kind: "shape" },
      ],
    };
    const { ctx, calls } = fakeAe({
      captionsTemplate: [{ comp_id: 42, name: "My Captions", width: 1080, height: 1920, duration_s: 5, controllers: after.controllers, controllers_named: true, has_box: true, look: "pop", warnings: [] }],
      captionsTemplateRead: [after],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    expect(calls.map((c) => c.fn)).not.toContain("captionsApply");
    const sent = argsOf(calls, "captionsTemplate");
    expect(sent.make_template).toEqual({ name: "My Captions" });
    expect(sent.box).toEqual({ color: [0, 0, 0], opacity: 50, padding: 24, roundness: 0 });
    expect(sent.look).toBe("pop");
    expect(sent.style).toEqual({ font_size: 70 });
    expect(argsOf(calls, "captionsTemplateRead")).toEqual({ comp_id: 42 });
    expect(out).toMatchObject({ comp_id: 1, template_comp_id: 42, template_name: "My Captions", controllers: after.controllers, next: "ae_save, then ae_export_mogrt with comp_id 42" });
    expect(out.receipt.matches).toBe(true);
  });

  it("the default name is '<name_prefix> Template', and a missing controller fails the receipt", async () => {
    const a = AeCaptionsSchema.parse({ comp_id: 1, expect: expectArg, make_template: {}, name_prefix: "Sub" });
    const after = { comp_id: 9, name: "Sub Template", controllers: ["Caption Text"], layers: [{ name: "Caption", id: 1, kind: "text", has_fill_effect: true }] };
    const { ctx, calls } = fakeAe({
      captionsTemplate: [{ comp_id: 9, name: "Sub Template", controllers: ["Caption Text"], controllers_named: true, has_box: false, look: "none", warnings: [] }],
      captionsTemplateRead: [after],
    });
    const out = await tool("ae_captions").handler(a, ctx);
    expect(argsOf(calls, "captionsTemplate").make_template.name).toBe("Sub Template");
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((x: { path: string }) => x.path)).toContain("template.controllers");
  });
});
