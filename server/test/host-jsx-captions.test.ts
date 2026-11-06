import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTION_DEFAULT_MARGINS, platformMargins } from "../src/tools/ext/captions.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, PropertyValueType, TextDocument, loadHost, type FakeComp } from "./support/fake-ae.js";

// The host half of the caption modes beyond layers and single: words, template, parent_to_null, precompose,
// match 'time' (the mapping Node computes), the platform margins and the lower-right rail flag.

const origAdd = FakeGroup.prototype.addProperty;
const origSet = FakeProperty.prototype.setValueAtTime;
const origSetValue = FakeProperty.prototype.setValue;
const origRect = FakeLayer.prototype.sourceRectAtTime;

/** AE copies a TextDocument on the way in; the fake keeps the reference. */
const copyDoc = (v: unknown) => (v instanceof TextDocument ? Object.assign(new TextDocument(v.text), v) : v);

beforeAll(() => {
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
  // Text measures like a monospaced font: half the font size per character, so a space is half a size wide. Other layers keep their rect.
  (FakeLayer.prototype as any).sourceRectAtTime = function (this: FakeLayer) {
    if (this.reflect.name !== "TextLayer" || (this as any).fixedRect) return origRect.call(this);
    const d = ((this.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).value as TextDocument;
    const lines = String(d.text).split("\r");
    const widest = Math.max(...lines.map((l) => l.length));
    return { left: 0, top: -d.fontSize, width: widest * d.fontSize * 0.5, height: lines.length * d.fontSize * 1.2 };
  };
});
afterAll(() => {
  FakeGroup.prototype.addProperty = origAdd;
  FakeProperty.prototype.setValueAtTime = origSet;
  FakeProperty.prototype.setValue = origSetValue;
  FakeLayer.prototype.sourceRectAtTime = origRect;
});

function scene(width = 1080, height = 1920) {
  const project = new FakeProject();
  project.refuseCircularLayers = true;
  project.strictRefs = true;
  const comp = project.addComp("Vertical", width, height, 20);
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
    default_margins: CAPTION_DEFAULT_MARGINS,
    expect: GUARD,
    ...extra,
  });

const read = (A: any, comp: FakeComp, extra: Record<string, unknown> = {}) =>
  A.captionsRead({ comp_id: comp.id, name_prefix: "Caption", mode: "layers", default_margins: CAPTION_DEFAULT_MARGINS, ...extra });

/** A text layer whose extents a test sets itself, instead of measuring its text. */
const fixRect = (l: FakeLayer, rect: { left: number; top: number; width: number; height: number }) => {
  l.rect = rect;
  (l as any).fixedRect = true;
};
const names = (c: FakeComp) => c.stack.map((l) => l.name);
const docOf = (l: FakeLayer) => ((l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).value as TextDocument;
const pos = (l: FakeLayer) => (l.transform("Position").value as number[]).slice(0, 2);
const kind = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e.__kind as string;
  }
  return "no error";
};
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return String(e.message);
  }
  return "";
};

// ---------- words mode ----------

describe("captionsApply: words mode", () => {
  it("makes one layer per word, named by caption and word, each visible from its word to the caption's end", () => {
    const { comp, A, undo } = scene();
    const out = apply(A, comp, { mode: "words" });
    expect(out.created).toEqual(["Caption 001.01", "Caption 001.02", "Caption 002.01", "Caption 002.02", "Caption 002.03"]);
    expect(out.word_layers).toBe(5);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    const w2 = comp.layer("Caption 001.02")!;
    expect(docOf(w2).text).toBe("there");
    expect(w2.inPoint).toBeCloseTo(1.2, 6);
    expect(w2.outPoint).toBeCloseTo(2, 6);
    expect(comp.layer("Caption 001.01")!.inPoint).toBeCloseTo(0.4, 6);
    expect(comp.layer("Caption 002.03")!.inPoint).toBeCloseTo(4.0, 6);
    // Each caption reports first word to end: that is what the read-back sees as in and out.
    expect(out.timings[0][0]).toBeCloseTo(0.4, 6);
    expect(out.timings[1][1]).toBeCloseTo(4.4, 6);
    // Left justified, so a word's position is its left edge.
    expect((docOf(w2) as any).justification).toBe(7413);
  });

  it("lays the words out in the caption's lines: left to right, the second line below, each line centred", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words" });
    const p = (n: string) => pos(comp.layer(n)!);
    // Font 65: half a size per character (32.5 px), a space is 32.5 px.
    // "Hello there": 5 and 5 characters = 162.5 each, one space: width 357.5, left edge (1080 - 357.5) / 2.
    expect(p("Caption 001.01")[0]).toBeCloseTo((1080 - 357.5) / 2, 6);
    expect(p("Caption 001.02")[0]).toBeCloseTo((1080 - 357.5) / 2 + 162.5 + 32.5, 6);
    expect(p("Caption 001.02")[1]).toBe(p("Caption 001.01")[1]);
    // "Second" on line one, "caption here" (227.5 + 32.5 + 130 = 390) on line two.
    expect(p("Caption 002.01")[0]).toBeCloseTo((1080 - 195) / 2, 6);
    expect(p("Caption 002.02")[0]).toBeCloseTo((1080 - 390) / 2, 6);
    expect(p("Caption 002.03")[0]).toBeCloseTo((1080 - 390) / 2 + 227.5 + 32.5, 6);
    expect(p("Caption 002.02")[1] - p("Caption 002.01")[1]).toBeCloseTo(65 * 1.2, 6);
    expect(p("Caption 002.03")[1]).toBe(p("Caption 002.02")[1]);
    // The last line sits where a one-line caption's baseline would: the bottom of the reels_9_16 box (1920 - 672).
    expect(p("Caption 002.03")[1]).toBeCloseTo(1248 - 65 * 0.25, 6);
  });

  it("keeps the real gap between words: side bearings are part of it, not just one measured space", () => {
    const { comp, A } = scene();
    const mono = (FakeLayer.prototype as any).sourceRectAtTime;
    // Ink extents: each string loses a bearing of 0.1 x the size on both sides, and its ink starts one bearing in.
    (FakeLayer.prototype as any).sourceRectAtTime = function (this: FakeLayer) {
      const r = mono.call(this);
      if (this.reflect.name !== "TextLayer" || (this as any).fixedRect) return r;
      const d = docOf(this);
      const b = d.fontSize * 0.1;
      return { ...r, left: b, width: r.width - 2 * b };
    };
    try {
      apply(A, comp, { mode: "words" });
    } finally {
      (FakeLayer.prototype as any).sourceRectAtTime = mono;
    }
    const inkLeft = (n: string) => pos(comp.layer(n)!)[0] + 6.5;
    const w1 = 162.5 - 13;
    // The gap between the two inks is the space (32.5) plus both bearings (13), as in the typeset line.
    expect(inkLeft("Caption 001.02") - (inkLeft("Caption 001.01") + w1)).toBeCloseTo(32.5 + 13, 6);
    // The line is centred on its typeset ink width (344.5).
    expect(inkLeft("Caption 001.01")).toBeCloseTo((1080 - 344.5) / 2, 6);
    // The text of the first word layer was put back after measuring.
    expect(String(docOf(comp.layer("Caption 001.01")!).text)).toBe("Hello");
  });

  it("places words by typeset advance with a font of uneven side bearings: every pair keeps the gap the line has", () => {
    const { comp, A } = scene();
    const mono = (FakeLayer.prototype as any).sourceRectAtTime;
    // A made-up face, in em: each glyph has its own advance and bearings; the space is 0.31 em. Ink starts at the first
    // glyph's left bearing and stops at the last glyph's right edge; trailing spaces are not measured (as in After Effects).
    const EM: Record<string, [number, number, number]> = {
      L: [0.55, 0.09, 0.02], a: [0.5, 0.03, 0.04], n: [0.55, 0.07, 0.07], d: [0.56, 0.03, 0.08], R: [0.66, 0.1, 0.01], o: [0.55, 0.04, 0.04],
      v: [0.5, 0.01, 0.01], e: [0.52, 0.04, 0.04], r: [0.35, 0.07, 0.0], D: [0.7, 0.1, 0.05], f: [0.3, 0.0, -0.02], h: [0.56, 0.07, 0.07],
      s: [0.46, 0.03, 0.03], t: [0.33, 0.01, 0.02], "|": [0.28, 0.09, 0.09], " ": [0.31, 0, 0],
    };
    const SIZE = 65;
    const ink = (text: string) => {
      let x = 0;
      let left: number | undefined;
      let right = 0;
      for (const ch of text) {
        const [adv, l, r] = EM[ch] ?? [0.5, 0.05, 0.05];
        if (ch !== " ") {
          if (left === undefined) left = x + l * SIZE;
          right = x + (adv - r) * SIZE;
        }
        x += adv * SIZE;
      }
      return { left: left ?? 0, right, adv: x };
    };
    (FakeLayer.prototype as any).sourceRectAtTime = function (this: FakeLayer) {
      const r = mono.call(this);
      if (this.reflect.name !== "TextLayer" || (this as any).fixedRect) return r;
      const m = ink(String(docOf(this).text));
      return { ...r, left: m.left, width: m.right - m.left };
    };
    const line = ["Land", "Rover", "Defender", "hero", "shots"];
    try {
      apply(A, comp, { mode: "words", captions: [cap(0, 4, [line.join(" ")], [0, 0.6, 1.2, 2, 2.6])] });
    } finally {
      (FakeLayer.prototype as any).sourceRectAtTime = mono;
    }
    const total = ink(line.join(" ")).adv;
    const origin = (1080 - total) / 2;
    const gaps: number[] = [];
    const want: number[] = [];
    let prevRight = 0;
    let typeset = 0;
    line.forEach((wd, k) => {
      const m = ink(wd);
      const x = pos(comp.layer("Caption 001.0" + (k + 1))!)[0];
      // Where the word's ink really is in the comp, and where the typeset line puts it.
      const inkL = x + m.left;
      const expectL = origin + typeset + m.left;
      expect(inkL).toBeCloseTo(expectL, 5);
      if (k > 0) {
        gaps.push(inkL - prevRight);
        want.push(expectL - (origin + typeset - ink(line[k - 1] + " ").adv + ink(line[k - 1]).right));
      }
      prevRight = x + m.right;
      typeset += ink(wd + " ").adv;
    });
    // The gaps differ pair to pair (the face has uneven bearings), and each one is the line's own.
    expect(new Set(gaps.map((g) => Math.round(g * 10))).size).toBeGreaterThan(2);
    gaps.forEach((g, i) => expect(g).toBeCloseTo(want[i], 5));
    expect(String(docOf(comp.layer("Caption 001.01")!).text)).toBe("Land");
    expect((docOf(comp.layer("Caption 001.01")!) as any).justification).toBe(7413);
  });

  it("read-back: a descender below the safe bottom is allowed by 0.3 x the font size, as in layers mode", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words", captions: [cap(0, 2, ["Hello there"], [0, 1])] });
    const wordsOf = (n: string) => comp.stack.filter((l) => l.name.startsWith("Caption " + n));
    // The baseline sits at 1248 - 0.25 x 65; the ink bottom is set from it. 0.2 x 65 below the safe bottom is a comma: fine.
    const setBottom = (below: number) => {
      for (const l of wordsOf("001")) fixRect(l, { left: 0, top: -65, width: 100, height: 65 + (1248 + below - (1248 - 16.25)) });
    };
    setBottom(13);
    const ok = read(A, comp, { mode: "words" }).captions[0];
    expect(ok.outside_safe).toBe(false);
    // 0.4 x 65 below: more than a descender.
    setBottom(26);
    const bad = read(A, comp, { mode: "words" }).captions[0];
    expect(bad.outside_safe).toBe(true);
  });

  it("justifies the lines left or right inside the safe area", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words", style: { justification: "left" } });
    expect(pos(comp.layer("Caption 002.02")!)[0]).toBeCloseTo(120, 6);
    expect(pos(comp.layer("Caption 002.03")!)[0]).toBeCloseTo(120 + 260, 6);
    const other = scene();
    apply(other.A, other.comp, { mode: "words", style: { justification: "right" } });
    // Right edge of "caption here" at 1080 - 192.
    expect(pos(other.comp.layer("Caption 002.03")!)[0] + 130).toBeCloseTo(888, 6);
  });

  it("updates by name: a changed caption is rebuilt, words past the new count go, others keep their place", () => {
    const { comp, A, undo } = scene();
    apply(A, comp, { mode: "words" });
    const before = pos(comp.layer("Caption 002.02")!);
    // User moves a word of caption 2; a re-run with the same words leaves it.
    comp.layer("Caption 002.02")!.transform("Position").setValue([10, 10]);
    const same = apply(A, comp, { mode: "words" });
    expect(same.created).toEqual([]);
    expect(pos(comp.layer("Caption 002.02")!)).toEqual([10, 10]);
    expect(before[0]).not.toBe(10);
    // Caption 1 loses a word: "Hello" only. The second word layer is removed and the first re-laid out (centred).
    const edited = apply(A, comp, { mode: "words", captions: [cap(0.4, 2, ["Hello"], [0.4]), CAPS[1]] });
    // A caption whose words changed gets new word layers (AE measures stale rects after a text change): both old ones go.
    expect(edited.removed.sort()).toEqual(["Caption 001.01", "Caption 001.02"]);
    expect(edited.created).toEqual(["Caption 001.01"]);
    expect(comp.stack.filter((l) => l.name === "Caption 001.01")).toHaveLength(1);
    expect(comp.layer("Caption 001.02")).toBeNull();
    expect(pos(comp.layer("Caption 001.01")!)[0]).toBeCloseTo((1080 - 162.5) / 2, 6);
    expect(undo.begun).toBe(3);
  });

  it("removes the words of captions past the new count", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words" });
    const out = apply(A, comp, { mode: "words", captions: [CAPS[0]] });
    expect(out.removed.sort()).toEqual(["Caption 002.01", "Caption 002.02", "Caption 002.03"]);
    expect(names(comp).sort()).toEqual(["Caption 001.01", "Caption 001.02"]);
  });

  it("refuses before the undo group: highlight, box, and a word count that does not match the times", () => {
    const { comp, A, undo } = scene();
    expect(kind(() => apply(A, comp, { mode: "words", highlight: { color: [1, 1, 0] } }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { mode: "words", box: { color: [0, 0, 0], opacity: 50, padding: 10, roundness: 0 } }))).toBe("bad_args");
    expect(message(() => apply(A, comp, { mode: "words", captions: [cap(0.4, 2, ["Hello there"], [0.4])] }))).toMatch(/needs one time per word/);
    expect(kind(() => apply(A, comp, { mode: "words", captions: [cap(0.4, 2, ["Hello there"])] }))).toBe("bad_args");
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(0);
  });

  it("reads words back per caption: joined text, word layer count, union extents", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words" });
    const r = read(A, comp, { mode: "words" });
    expect(r.mode).toBe("words");
    expect(r.total_captions).toBe(2);
    const [c1, c2] = r.captions;
    expect(c1).toMatchObject({ number: 1, name: "Caption 001", kind: "words", text: "Hello there", word_layers: 2 });
    expect(c1.inPoint).toBeCloseTo(0.4, 6);
    expect(c1.outPoint).toBeCloseTo(2, 6);
    expect(c1.words.map((w: any) => w.text)).toEqual(["Hello", "there"]);
    expect(c2.text).toBe("Second caption here");
    expect(c2.word_layers).toBe(3);
    // The union is the two lines' box in comp space: inside the reels_9_16 box (x 120..888, y 288..1248).
    expect(c2.rect.width).toBeCloseTo(390, 6);
    expect(c2.outside_safe).toBe(false);
  });

  it("flags a words caption that runs wider than the safe area", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words", captions: [cap(0.4, 2, ["A very long line of words indeed here"], [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1])] });
    const r = read(A, comp, { mode: "words" });
    expect(r.captions[0].outside_safe).toBe(true);
  });
});

// ---------- template mode ----------

function templateScene(controllers = ["Line 1", "Line 2", "Name"], text = controllers) {
  const s = scene();
  const tpl = s.project.addComp("Lower Third", 1080, 1920, 6);
  tpl.frameRate = 25;
  tpl.controllers = [...controllers];
  for (const c of text) tpl.textControllers.add(c);
  return { ...s, tpl };
}

const FIELDS = { "Line 1": "line1", "Line 2": "line2", Name: "speaker" } as const;
const tplArgs = (tpl: FakeComp, fields: Record<string, string> = FIELDS) => ({ mode: "template", template: { comp_id: tpl.id, fields } });
const essentials = (l: FakeLayer) => {
  const g = l.property("ADBE Layer Overrides") as FakeGroup;
  const out: Record<string, string> = {};
  for (const p of g.props as FakeProperty[]) out[p.name] = ((p.value as TextDocument).text ?? p.value) as string;
  return out;
};

describe("captionsApply: template mode", () => {
  const CAPS_S = [
    { ...cap(0.4, 2, ["Hello there"], [0.4, 1.2]), speaker: "ANNA" },
    { ...cap(3.2, 4.4, ["Second", "caption here"], [3.2, 3.8, 4.0]), speaker: "BEN" },
  ];

  it("makes one instance of the template per caption and fills its Essential Properties", () => {
    const { comp, tpl, A, undo } = templateScene();
    const out = apply(A, comp, { ...tplArgs(tpl), captions: CAPS_S });
    expect(out.created).toEqual(["Caption 001", "Caption 002"]);
    expect(out.template).toMatchObject({ comp_id: tpl.id, name: "Lower Third", fields: 3 });
    expect(undo.begun).toBe(1);
    const one = comp.layer("Caption 001")!;
    const two = comp.layer("Caption 002")!;
    expect((one.source as FakeComp).id).toBe(tpl.id);
    expect(essentials(one)).toEqual({ "Line 1": "Hello there", "Line 2": "", Name: "ANNA" });
    expect(essentials(two)).toEqual({ "Line 1": "Second", "Line 2": "caption here", Name: "BEN" });
    // The template's own time 0 is the caption's in point.
    expect(two.startTime).toBeCloseTo(3.2, 6);
    expect(two.inPoint).toBeCloseTo(3.2, 6);
    expect(two.outPoint).toBeCloseTo(4.4, 6);
    // Not moved: the position the template layer was added with.
    expect(pos(one)).toEqual([540, 960]);
  });

  it("fills a whole-text field with the lines joined by line breaks, and updates by name", () => {
    const { comp, tpl, A } = templateScene(["Text"]);
    apply(A, comp, { ...tplArgs(tpl, { Text: "text" }), captions: CAPS_S });
    expect(essentials(comp.layer("Caption 002")!)).toEqual({ Text: "Second\rcaption here" });
    const again = apply(A, comp, { ...tplArgs(tpl, { Text: "text" }), captions: [{ ...CAPS_S[0], lines: ["Changed"] }, CAPS_S[1]] });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual(["Caption 001", "Caption 002"]);
    expect(essentials(comp.layer("Caption 001")!)).toEqual({ Text: "Changed" });
  });

  it("moves the instance vertically into the safe area only when a layout is given", () => {
    const { comp, tpl, A } = templateScene();
    // The fake's precomp layer rect is the template comp: 1920 high, so its bottom is moved up to the box bottom (1248).
    apply(A, comp, { ...tplArgs(tpl), captions: CAPS_S, layout: { position: "bottom" } });
    const l = comp.layer("Caption 001")!;
    // The fake's layer rect is the whole template comp (1920 high, top at 0, anchor 0).
    expect(pos(l)[1] + 1920).toBeCloseTo(1248, 6);
  });

  it("places each instance like layers mode (last line on the safe area's bottom, whatever its line count) and respects layout.position", () => {
    const { comp, project, tpl: _t, A } = templateScene();
    comp.width = 1920;
    comp.height = 1080;
    // A template made by make_template (1920x1080 here): its caption text layer 'Caption' with a 'Caption Text' controller.
    const made = A.captionsTemplate({ comp_id: comp.id, make_template: { name: "Cap T" }, style: { font_size: 65 }, default_margins: CAPTION_DEFAULT_MARGINS, expect: GUARD });
    const tpl2 = project.itemByID(made.comp_id) as FakeComp;
    tpl2.textControllers.add("Caption Text");
    const fields = { "Caption Text": "text" };
    const caps = [cap(0.4, 2, ["One line only"], [0.4, 1.0, 1.4]), cap(3.2, 4.4, ["Second line", "of two"], [3.2, 3.8, 4.0, 4.1])];
    apply(A, comp, { mode: "template", template: { comp_id: tpl2.id, fields }, captions: caps });
    const safeBottom = 1080 - 1080 * 0.05;
    const lh = 65 * 1.2;
    const textPos = (n: string) => {
      // Where the caption's first baseline lands in the target: the instance's offset from where it was added, plus the template's own.
      const inst = comp.layer(n)!;
      const own = tpl2.layer("Caption")!.transform("Position").value as number[];
      const ip = inst.transform("Position").value as number[];
      const ia = inst.transform("Anchor Point").value as number[];
      return [ip[0] - ia[0] + own[0], ip[1] - ia[1] + own[1]];
    };
    // One line: its baseline is a quarter size above the bottom; two lines: the first baseline one leading higher.
    expect(textPos("Caption 001")[1]).toBeCloseTo(safeBottom - 65 * 0.25, 6);
    expect(textPos("Caption 002")[1]).toBeCloseTo(safeBottom - 65 * 0.25 - lh, 6);
    expect(textPos("Caption 001")[0]).toBeCloseTo(960, 6);
    // The two lines are one Essential Property value, joined by AE's line break.
    expect(essentials(comp.layer("Caption 002")!)["Caption Text"]).toBe("Second line\rof two");
    // layout.position top, on a re-run with restyle.
    apply(A, comp, { mode: "template", template: { comp_id: tpl2.id, fields }, captions: caps, layout: { position: "top" }, restyle: true });
    expect(textPos("Caption 001")[1]).toBeCloseTo(1080 * 0.05 + 65 * 0.8, 6);
  });

  it("warns when the template comp is too short for a caption's lines (they would be cut off at its edge)", () => {
    const { comp, project, A } = templateScene();
    comp.width = 1920;
    comp.height = 1080;
    const made = A.captionsTemplate({ comp_id: comp.id, make_template: { name: "Tight", lines: 1 }, style: { font_size: 65 }, default_margins: CAPTION_DEFAULT_MARGINS, expect: GUARD });
    const t = project.itemByID(made.comp_id) as FakeComp;
    t.textControllers.add("Caption Text");
    // Shrink the template under its text: the first baseline now sits near its bottom.
    t.height = 300;
    const first = t.layer("Caption")!;
    first.transform("Position").setValue([960, 280]);
    const out = apply(A, comp, { mode: "template", template: { comp_id: t.id, fields: { "Caption Text": "text" } }, captions: [cap(3.2, 4.4, ["Second line", "of two"], [3.2, 3.8, 4.0, 4.1])] });
    expect(out.warnings.join(" ")).toContain("cut off");
  });

  it("refuses before the undo group: a property the template lacks (listing the ones it has), itself, a circular reference, a non-text property", () => {
    const { comp, project, tpl, A, undo } = templateScene();
    const m = message(() => apply(A, comp, { ...tplArgs(tpl, { "Line 3": "line1" }), captions: CAPS_S }));
    expect(m).toMatch(/no Essential Property named "Line 3"/);
    expect(m).toMatch(/Line 1, Line 2, Name/);
    expect(message(() => apply(A, comp, { ...tplArgs(comp), captions: CAPS_S }))).toMatch(/is the comp the captions go into/);
    // The template holds the target comp: an instance in the target would loop.
    const loop = project.addComp("Loop", 1080, 1920, 6);
    loop.controllers = ["Line 1"];
    loop.textControllers.add("Line 1");
    loop.layers.add(comp);
    expect(message(() => apply(A, comp, { ...tplArgs(loop, { "Line 1": "line1" }), captions: CAPS_S }))).toMatch(/circular reference/);
    const bare = project.addComp("Bare", 1080, 1920, 6);
    expect(message(() => apply(A, comp, { ...tplArgs(bare, { X: "text" }), captions: CAPS_S }))).toMatch(/\(none; add properties/);
    expect(kind(() => apply(A, comp, { ...tplArgs(tpl, { "Line 1": "headline" }), captions: CAPS_S }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { ...tplArgs(tpl, {}), captions: CAPS_S }))).toBe("bad_args");
    expect(kind(() => apply(A, comp, { mode: "template", captions: CAPS_S }))).toBe("bad_args");
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(0);
  });

  it("takes back its layers when an Essential Property is not text", () => {
    // 'Name' is a controller but not a text one.
    const { comp, tpl, A } = templateScene(["Line 1", "Name"], ["Line 1"]);
    expect(message(() => apply(A, comp, { ...tplArgs(tpl, { "Line 1": "line1", Name: "speaker" }), captions: CAPS_S }))).toMatch(/not a text property/);
    expect(comp.numLayers).toBe(0);
  });

  it("refuses a caption layer that is not an instance of this template, and highlight or box", () => {
    const { comp, tpl, A } = templateScene();
    apply(A, comp, { captions: [CAPS_S[0]] });
    expect(message(() => apply(A, comp, { ...tplArgs(tpl), captions: CAPS_S }))).toMatch(/not a precomp layer/);
    const s2 = templateScene();
    expect(kind(() => apply(s2.A, s2.comp, { ...tplArgs(s2.tpl), captions: CAPS_S, highlight: { color: [1, 1, 0] } }))).toBe("bad_args");
    expect(kind(() => apply(s2.A, s2.comp, { ...tplArgs(s2.tpl), captions: CAPS_S, box: { color: [0, 0, 0], opacity: 50, padding: 10, roundness: 0 } }))).toBe("bad_args");
  });

  it("reads the instances back with their Essential Property values", () => {
    const { comp, tpl, A } = templateScene();
    apply(A, comp, { ...tplArgs(tpl), captions: CAPS_S });
    const r = read(A, comp, { mode: "template" });
    expect(r.captions).toHaveLength(2);
    expect(r.captions[1]).toMatchObject({ number: 2, kind: "template", source_comp_id: tpl.id, essential: { "Line 1": "Second", "Line 2": "caption here", Name: "BEN" } });
    expect(r.captions[1].inPoint).toBeCloseTo(3.2, 6);
  });
});

// ---------- parent_to_null ----------

describe("captionsApply: parent_to_null", () => {
  it("makes a control null once and parents every caption (and box) to it without moving them", () => {
    const { comp, A } = scene();
    const plain = scene();
    apply(plain.A, plain.comp, { box: { color: [0, 0, 0], opacity: 60, padding: 10, roundness: 0 } });
    const out = apply(A, comp, { parent_to_null: true, box: { color: [0, 0, 0], opacity: 60, padding: 10, roundness: 0 } });
    const control = comp.layer("Caption Control")!;
    expect(control.nullLayer).toBe(true);
    expect(out.control).toMatchObject({ name: "Caption Control", created: true });
    for (const n of ["Caption 001", "Caption 002", "Caption 001 Box", "Caption 002 Box"]) {
      expect(comp.layer(n)!.parent?.id).toBe(control.id);
    }
    expect(control.parent).toBeNull();
    expect(pos(comp.layer("Caption 001")!)).toEqual(pos(plain.comp.layer("Caption 001")!));
    // Re-running reuses the null.
    const again = apply(A, comp, { parent_to_null: true, box: { color: [0, 0, 0], opacity: 60, padding: 10, roundness: 0 } });
    expect(again.control).toMatchObject({ created: false, id: control.id });
    expect(comp.stack.filter((l) => l.name === "Caption Control")).toHaveLength(1);
  });

  it("parents words too, and refuses a non-null layer of the control's name", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words", parent_to_null: true });
    const control = comp.layer("Caption Control")!;
    expect(comp.layer("Caption 002.03")!.parent?.id).toBe(control.id);
    const other = scene();
    other.comp.layers.addText("Caption Control");
    other.comp.layer("Caption Control")!.name = "Caption Control";
    expect(message(() => apply(other.A, other.comp, { parent_to_null: true }))).toMatch(/not a null layer/);
    expect(other.undo.begun).toBe(0);
  });
});

// ---------- precompose ----------

describe("captionsApply: precompose", () => {
  it("moves the caption layers (and the control) into '<prefix> Captions' and reports its id", () => {
    const { comp, project, A, undo } = scene();
    const out = apply(A, comp, { precompose: true, parent_to_null: true });
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(out.precomp).toMatchObject({ name: "Caption Captions", created: true });
    expect(names(comp)).toEqual(["Caption Captions"]);
    const inner = project.itemByID(out.precomp.comp_id) as FakeComp;
    expect(inner.name).toBe("Caption Captions");
    expect(out.target_comp_id).toBe(inner.id);
    expect(names(inner).sort()).toEqual(["Caption 001", "Caption 002", "Caption Control"]);
    expect(inner.frameRate).toBe(25);
    expect(comp.layer("Caption Captions")!.id).toBe(out.precomp.layer_id);
  });

  it("a re-run updates the captions inside the precomp and adds no layer outside", () => {
    const { comp, project, A } = scene();
    const first = apply(A, comp, { precompose: true });
    const inner = project.itemByID(first.precomp.comp_id) as FakeComp;
    const edited = apply(A, comp, { precompose: true, captions: [cap(0.4, 2, ["Edited text"], [0.4, 1.2]), CAPS[1]] });
    expect(edited.created).toEqual([]);
    expect(edited.updated).toEqual(["Caption 001", "Caption 002"]);
    expect(edited.precomp).toMatchObject({ comp_id: inner.id, created: false });
    expect(edited.target_comp_id).toBe(inner.id);
    expect(names(comp)).toEqual(["Caption Captions"]);
    expect(docOf(inner.layer("Caption 001")!).text).toBe("Edited text");
    // The read can follow the precomp in.
    const r = read(A, comp, { through_precomp: true });
    expect(r.comp_id).toBe(inner.id);
    expect(r.total_captions).toBe(2);
    expect(read(A, comp).total_captions).toBe(0);
  });

  it("refuses a layer of the precomp's name that is not a precomp, before the undo group", () => {
    const { comp, A, undo } = scene();
    comp.layers.addText("x").name = "Caption Captions";
    expect(message(() => apply(A, comp, { precompose: true }))).toMatch(/not a precomp layer/);
    expect(undo.begun).toBe(0);
  });
});

// ---------- match 'time' ----------

describe("captionsApply: match by time (the mapping Node computes)", () => {
  const BOX = { color: [0, 0, 0], opacity: 60, padding: 10, roundness: 0 };

  it("renumbers matched layers, creates the missing caption and keeps the user's position", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const l1 = comp.layer("Caption 001")!;
    const l2 = comp.layer("Caption 002")!;
    l1.transform("Position").setValue([11, 22]);
    // A new first caption appears: the old two become 2 and 3.
    const out = apply(A, comp, {
      captions: [cap(0, 0.3, ["New one"]), cap(0.4, 2, ["Hello again"]), cap(3.2, 4.4, ["Second", "caption here"])],
      mapping: [{ layer_id: l1.id, number: 2 }, { layer_id: l2.id, number: 3 }],
    });
    expect(out.created).toEqual(["Caption 001"]);
    expect(out.renamed).toBe(2);
    expect(l1.name).toBe("Caption 002");
    expect(l2.name).toBe("Caption 003");
    expect(docOf(l1).text).toBe("Hello again");
    expect(pos(l1)).toEqual([11, 22]);
    expect(names(comp).sort()).toEqual(["Caption 001", "Caption 002", "Caption 003"]);
    expect(comp.layer("Caption 001")!.inPoint).toBe(0);
  });

  it("removes an unmatched layer only with remove_stale, and refuses a clash otherwise", () => {
    const one = scene();
    apply(one.A, one.comp);
    const l1 = one.comp.layer("Caption 001")!;
    const l2 = one.comp.layer("Caption 002")!;
    // The transcript lost its first caption: layer 2 becomes caption 1; layer 1 matches nothing.
    const args = { captions: [cap(3.2, 4.4, ["Second", "caption here"])], mapping: [{ layer_id: l2.id, number: 1 }] };
    expect(message(() => apply(one.A, one.comp, { ...args, remove_stale: false }))).toMatch(/matches no new caption/);
    expect(one.undo.begun).toBe(1);
    const out = apply(one.A, one.comp, { ...args, remove_stale: true });
    expect(out.removed).toEqual(["Caption 001"]);
    expect(l2.name).toBe("Caption 001");
    expect(one.comp.stack.includes(l1)).toBe(false);
    expect(names(one.comp)).toEqual(["Caption 001"]);
  });

  it("points a box's expressions at the renamed text layer and renames the box", () => {
    const { comp, A } = scene();
    apply(A, comp, { box: BOX });
    const l1 = comp.layer("Caption 001")!;
    const l2 = comp.layer("Caption 002")!;
    apply(A, comp, {
      captions: [cap(0, 0.3, ["New one"]), cap(0.4, 2, ["Hello"]), cap(3.2, 4.4, ["Second"])],
      mapping: [{ layer_id: l1.id, number: 2 }, { layer_id: l2.id, number: 3 }],
      box: BOX,
    });
    expect(names(comp).sort()).toEqual(["Caption 001", "Caption 001 Box", "Caption 002", "Caption 002 Box", "Caption 003", "Caption 003 Box"]);
    const sizeOf = (box: FakeLayer) => {
      const rect = (box.property("ADBE Root Vectors Group") as FakeGroup).property(1) as FakeGroup;
      return (((rect.property("ADBE Vectors Group") as FakeGroup).property("ADBE Vector Shape - Rect") as FakeGroup).property("ADBE Vector Rect Size") as FakeProperty).expression;
    };
    expect(sizeOf(comp.layer("Caption 002 Box")!)).toContain('thisComp.layer("Caption 002")');
    expect(sizeOf(comp.layer("Caption 003 Box")!)).toContain('thisComp.layer("Caption 003")');
  });

  it("works in words mode by caption", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words" });
    const first = comp.layer("Caption 001.01")!;
    const out = apply(A, comp, { mode: "words", captions: [cap(0, 0.3, ["Intro"], [0]), CAPS[0]], mapping: [{ layer_id: first.id, number: 2 }], remove_stale: true });
    expect(out.renamed).toBeGreaterThan(0);
    expect(comp.layer("Caption 002.01")!.id).toBe(first.id);
    expect(comp.layer("Caption 001.01")).not.toBeNull();
    // Caption 002 of the old run (three words) matched nothing and is gone.
    expect(names(comp).filter((n) => n.startsWith("Caption 002.")).sort()).toEqual(["Caption 002.01", "Caption 002.02"]);
  });

  it("refuses a mapping with an unknown layer, a number out of range or a layer used twice", () => {
    const { comp, A, undo } = scene();
    apply(A, comp);
    const l1 = comp.layer("Caption 001")!;
    expect(message(() => apply(A, comp, { mapping: [{ layer_id: 999999, number: 1 }] }))).toMatch(/no caption layer with id/);
    expect(message(() => apply(A, comp, { mapping: [{ layer_id: l1.id, number: 9 }] }))).toMatch(/outside 1\.\.2/);
    expect(message(() => apply(A, comp, { mapping: [{ layer_id: l1.id, number: 1 }, { layer_id: l1.id, number: 2 }] }))).toMatch(/twice/);
    expect(undo.begun).toBe(1);
  });
});

// ---------- platform margins and the rail ----------

describe("captionsApply and captionsRead: the platform safe area", () => {
  it("uses the reels_9_16 box for a 9:16 comp by default (the old 20% bottom is gone)", () => {
    const { comp, A } = scene();
    const out = apply(A, comp);
    expect(out.safe).toMatchObject({ left: 120, top: 288, bottom: 672 });
    expect(out.safe.width).toBeCloseTo(1080 - 120 - 192, 6);
    // One line sits above the bottom margin: 1920 - 672.
    expect(pos(comp.layer("Caption 001")!)[1]).toBeCloseTo(1248 - 65 * 0.25, 6);
  });

  it("takes an explicit platform, and layout.margins still win edge by edge", () => {
    const tiktok = scene();
    const a = apply(tiktok.A, tiktok.comp, { platform_margins: platformMargins("tiktok_9_16") });
    expect(a.safe).toMatchObject({ left: 120, top: 240, bottom: 660 });
    const both = scene();
    const b = apply(both.A, both.comp, { platform_margins: platformMargins("youtube_shorts_9_16"), layout: { margins: { bottom: 0.1 } } });
    expect(b.safe).toMatchObject({ left: 48, top: 288, bottom: 192 });
    expect(b.safe.width).toBeCloseTo(1080 - 48 - 192, 6);
  });

  it("keeps ae_reframe's margins for other shapes", () => {
    const { comp, A } = scene(1920, 1080);
    const out = apply(A, comp);
    expect(out.safe).toMatchObject({ left: 96, top: 54, bottom: 54 });
  });

  it("reads the safe area with the same platform and flags the lower-right rail", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const l = comp.layer("Caption 001")!;
    // 600 px wide centred on 540 reaches x 840: past 780, and the caption is below y 840.
    fixRect(l, { left: -300, top: -65, width: 600, height: 70 });
    const on = read(A, comp, { rail: true });
    expect(on.safe.rail).toBe(true);
    expect(on.captions[0].rail_overlap).toBe(true);
    expect(read(A, comp).captions[0].rail_overlap).toBeUndefined();
    // "auto" decides by the comp's shape: 9:16 yes.
    expect(read(A, comp, { rail: "auto" }).captions[0].rail_overlap).toBe(true);
    // A narrow caption stays clear of the rail.
    fixRect(l, { left: -100, top: -65, width: 200, height: 70 });
    expect(read(A, comp, { rail: true }).captions[0].rail_overlap).toBeUndefined();
    // Above y 840 the rail is the ordinary right margin.
    fixRect(l, { left: -300, top: -65, width: 600, height: 70 });
    l.transform("Position").setValue([540, 600]);
    expect(read(A, comp, { rail: true }).captions[0].rail_overlap).toBeUndefined();
  });

  it("does not check the rail on a landscape comp with auto", () => {
    const { comp, A } = scene(1920, 1080);
    apply(A, comp);
    fixRect(comp.layer("Caption 001")!, { left: -300, top: -65, width: 1500, height: 70 });
    expect(read(A, comp, { rail: "auto" }).captions[0].rail_overlap).toBeUndefined();
  });

  it("a platform's margins change the read-back's outside_safe judgement", () => {
    const { comp, A } = scene();
    apply(A, comp, { platform_margins: platformMargins("instagram_reels_9_16") });
    const l = comp.layer("Caption 001")!;
    fixRect(l, { left: -450, top: -65, width: 900, height: 70 });
    // 900 px wide centred: x 90..990. Inside Instagram's 65 px sides, outside reels_9_16's 120 / 192.
    expect(read(A, comp, { platform_margins: platformMargins("instagram_reels_9_16") }).captions[0].outside_safe).toBe(false);
    expect(read(A, comp).captions[0].outside_safe).toBe(true);
  });
});

// ---------- review fixes ----------

describe("captionsApply: review fixes", () => {
  it("precompose with parent_to_null reads nothing from layers that moved into the precomp", () => {
    const { comp, project, A } = scene();
    const out = apply(A, comp, { precompose: true, parent_to_null: true });
    const inner = project.itemByID(out.precomp.comp_id) as FakeComp;
    expect(out.control).toMatchObject({ name: "Caption Control", created: true, id: inner.layer("Caption Control")!.id });
  });

  it("the fake invalidates a layer that was precomposed away", () => {
    const { comp, A } = scene();
    apply(A, comp);
    const held = comp.layer("Caption 001")!;
    comp.layers.precompose([held.index], "P", true);
    expect(() => held.id).toThrow(/Object is invalid/);
  });

  it("removing look animators and highlights re-resolves the group for every read", () => {
    const { comp, A } = scene();
    const hl = { highlight: { color: [1, 1, 0] } };
    apply(A, comp, { look: "pop", ...hl });
    apply(A, comp, { look: "pop", ...hl });
    const anims = (comp.layer("Caption 001")!.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup;
    expect(anims.props.map((a) => a.name)).toEqual(["Caption Highlight", "Caption Look", "Caption Look Scale", "Caption Look Overshoot"].slice(0, anims.props.length));
    const out = apply(A, comp, {});
    expect(out.warnings.join(" ")).not.toMatch(/could not remove/);
    expect(((comp.layer("Caption 001")!.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup).props).toHaveLength(0);
  });

  it("words: the same words on other lines are laid out again, and a word moved on its line stays", () => {
    const { comp, A } = scene();
    const words = (lines: string[]) => [{ ...cap(0.4, 2, lines, [0.4, 1.2, 1.6]) }];
    apply(A, comp, { mode: "words", captions: words(["Hello there you"]) });
    const y1 = pos(comp.layer("Caption 001.01")!)[1];
    apply(A, comp, { mode: "words", captions: words(["Hello there", "you"]) });
    // Two lines sit higher in a bottom-aligned block, so the first word moved up.
    expect(pos(comp.layer("Caption 001.01")!)[1]).toBeLessThan(y1);
    // Same breaks again: a hand-moved word stays.
    comp.layer("Caption 001.01")!.transform("Position").setValue([5, 6, 0]);
    apply(A, comp, { mode: "words", captions: words(["Hello there", "you"]) });
    expect(pos(comp.layer("Caption 001.01")!)).toEqual([5, 6]);
  });

  it("refuses a moved or keyed control null before the undo group, for parent_to_null and for new layers", () => {
    const { comp, A, undo } = scene();
    apply(A, comp, { parent_to_null: true });
    const control = comp.layer("Caption Control")!;
    control.transform("Position").setValue([40, 0, 0]);
    const begun = undo.begun;
    expect(message(() => apply(A, comp, { parent_to_null: true }))).toMatch(/Caption Control.*position changed/);
    // New captions beyond the existing ones, with the captions still parented to the moved control.
    expect(message(() => apply(A, comp, { captions: [...CAPS, cap(5, 6, ["Third"], [5])] }))).toMatch(/position changed/);
    expect(message(() => apply(A, comp, { restyle: true }))).toMatch(/position changed/);
    expect(undo.begun).toBe(begun);
    // Back at identity: fine again.
    control.transform("Position").setValue([0, 0, 0]);
    expect(() => apply(A, comp, { parent_to_null: true })).not.toThrow();
    control.transform("Scale").setValue([50, 50, 50]);
    expect(message(() => apply(A, comp, { parent_to_null: true }))).toMatch(/scale changed/);
  });

  it("words with keyframes the tool did not make are refused before the undo group; its own pop keys are fine", () => {
    const { comp, A, undo } = scene();
    apply(A, comp, { mode: "words", look: "pop" });
    // The tool's own Scale and Opacity keys (look mark) are rebuilt without complaint.
    expect(() => apply(A, comp, { mode: "words", look: "pop" })).not.toThrow();
    const w = comp.layer("Caption 001.01")!;
    const begun = undo.begun;
    w.transform("Position").setValueAtTime(0, [1, 1, 0]);
    expect(message(() => apply(A, comp, { mode: "words" }))).toMatch(/keyframes on Position/);
    expect(undo.begun).toBe(begun);
    const s2 = scene();
    apply(s2.A, s2.comp, { mode: "words" });
    s2.comp.layer("Caption 001.01")!.transform("Scale").setValueAtTime(0, [90, 90, 100]);
    expect(message(() => apply(s2.A, s2.comp, { mode: "words", look: "pop" }))).toMatch(/keyframes on Scale/);
    expect(s2.undo.begun).toBe(1);
  });

  it("bounds the created, updated and removed lists to 500 with counts and a truncated flag", () => {
    const { comp, A } = scene();
    const many = Array.from({ length: 200 }, (_, i) => cap(i * 0.09, i * 0.09 + 0.08, ["a b c"], [i * 0.09, i * 0.09 + 0.02, i * 0.09 + 0.04]));
    const out = apply(A, comp, { mode: "words", captions: many });
    expect(out.created).toHaveLength(500);
    expect(out.created_count).toBe(600);
    expect(out.names_truncated).toBe(true);
    const small = apply(A, comp, { mode: "words", captions: many.slice(0, 150), remove_stale: true });
    expect(small.names_truncated).toBe(false);
    expect(small.removed_count).toBe(small.removed.length);
  });
});

describe("captionsApply: template validation before any write", () => {
  const CAPS_T = [
    { ...cap(0.4, 2, ["Hello there"], [0.4, 1.2]), speaker: "ANNA" },
    { ...cap(3.2, 4.4, ["Second", "caption here"], [3.2, 3.8, 4.0]), speaker: "BEN" },
  ];

  it("a non-text mapped property stops a first run with no layers left behind", () => {
    const { comp, tpl, A } = templateScene(["Line 1", "Line 2", "Name"], ["Line 1", "Line 2"]);
    expect(kind(() => apply(A, comp, { ...tplArgs(tpl), captions: CAPS_T }))).toBe("bad_args");
    expect(comp.stack).toHaveLength(0);
  });

  it("a template that changed under existing instances is refused before the undo group, leaving them as they were", () => {
    const { comp, tpl, A, undo } = templateScene();
    apply(A, comp, { ...tplArgs(tpl), captions: CAPS_T });
    tpl.textControllers.delete("Name");
    // Instances built before the change still hold a text property; a new instance (a third caption) sees the changed one.
    const begun = undo.begun;
    for (const l of comp.stack) (l as any).overrideGroup = null;
    expect(kind(() => apply(A, comp, { ...tplArgs(tpl), captions: [{ ...CAPS_T[0], lines: ["Changed"] }, CAPS_T[1]] }))).toBe("bad_args");
    expect(undo.begun).toBe(begun);
    expect(comp.stack).toHaveLength(2);
  });

  it("a new instance that fails validation is removed and existing instances are not touched", () => {
    const { comp, tpl, A } = templateScene();
    apply(A, comp, { ...tplArgs(tpl), captions: [CAPS_T[0]] });
    const before = essentials(comp.layer("Caption 001")!);
    tpl.textControllers.delete("Name");
    // The existing instance keeps its cached group; the new one is made after the change and fails.
    expect(kind(() => apply(A, comp, { ...tplArgs(tpl), captions: [{ ...CAPS_T[0], lines: ["Changed"] }, CAPS_T[1]] }))).toBe("bad_args");
    expect(comp.stack.map((l) => l.name)).toEqual(["Caption 001"]);
    expect(essentials(comp.layer("Caption 001")!)).toEqual(before);
  });
});
