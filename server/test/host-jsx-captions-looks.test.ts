import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTION_DEFAULT_MARGINS } from "../src/tools/ext/captions.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, PropertyValueType, TextDocument, loadHost, type FakeComp } from "./support/fake-ae.js";

// The host half of the caption looks (pop, pill_slide, fill_sweep), the speaker colours and lyric italics,
// and the caption template comp for Premiere, against the fake AE DOM.

const origAdd = FakeGroup.prototype.addProperty;
const origSet = FakeProperty.prototype.setValueAtTime;
const origSetValue = FakeProperty.prototype.setValue;
const origRect = FakeLayer.prototype.sourceRectAtTime;

/** AE copies a TextDocument on the way in; the fake keeps the reference. */
const copyDoc = (v: unknown) => (v instanceof TextDocument ? Object.assign(new TextDocument(v.text), v) : v);

beforeAll(() => {
  // A range selector in Index units has Index Start and End next to the percent ones.
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
  // Text measures like a monospaced font: half the font size per character; a text layer's lines are 1.2 sizes tall.
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
  project.strictRefs = true;
  const comp = project.addComp("Vertical", width, height, 20);
  comp.frameRate = 25;
  const host = loadHost(project, ["captions.jsx"]);
  host.G.ParagraphJustification = { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7414, RIGHT_JUSTIFY: 7415 };
  return { project, comp, ...host };
}

type W = [number, number];
const cap = (start: number, end: number, lines: string[], words?: W[], extra: Record<string, unknown> = {}) => ({
  start,
  end,
  lines,
  ...(words ? { words: words.map(([s, e]) => ({ start: s, end: e })) } : {}),
  ...extra,
});

const RED = [1, 0.2, 0.2];
const CAPS = [cap(0.4, 2, ["Hello there"], [[0.4, 0.8], [1.2, 1.8]]), cap(3.2, 4.4, ["Second", "caption here"], [[3.2, 3.6], [3.8, 4.0], [4.0, 4.4]])];

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

const names = (c: FakeComp) => c.stack.map((l) => l.name);
const docOf = (l: FakeLayer) => ((l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).value as TextDocument;
const animators = (l: FakeLayer) => {
  const g = (l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup;
  return g.props as FakeGroup[];
};
const selOf = (a: FakeGroup) => ((a.property("ADBE Text Selectors") as FakeGroup).property(1) as FakeGroup);
const sp = (sel: FakeGroup, mn: string) => (sel.property(mn) ?? (sel.property("ADBE Text Range Advanced") as FakeGroup).property(mn)) as FakeProperty;
const keysOf = (p: FakeProperty) => p.keys.map((k) => [Math.round(k.time * 1e6) / 1e6, k.value]);
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
const pillRect = (l: FakeLayer) => ((l.property("ADBE Root Vectors Group") as FakeGroup).property(1) as FakeGroup).property("ADBE Vectors Group") as FakeGroup;
const pillProp = (l: FakeLayer, mn: string) => (pillRect(l).property("ADBE Vector Shape - Rect") as FakeGroup).property(mn) as FakeProperty;

// ---------- speaker colour and lyric italics ----------

describe("captionsApply: speaker colour and italic", () => {
  const coloured = [cap(0.4, 2, ["Hello there"], undefined, { color: RED, italic: false }), cap(3.2, 4.4, ["Second", "caption here"], undefined, { color: null, italic: true })];

  it("layers: a coloured caption gets its fill, the others the style's; italics set fauxItalic", () => {
    const { comp, A } = scene();
    apply(A, comp, { captions: coloured, style: { fill_color: [1, 1, 1] } });
    expect(docOf(comp.layer("Caption 001")!).fillColor).toEqual(RED);
    expect(docOf(comp.layer("Caption 002")!).fillColor).toEqual([1, 1, 1]);
    expect((docOf(comp.layer("Caption 001")!) as any).fauxItalic).toBe(false);
    expect((docOf(comp.layer("Caption 002")!) as any).fauxItalic).toBe(true);
    const r = read(A, comp);
    expect(r.captions[0].fill).toEqual(RED);
    expect(r.captions[0].faux_italic).toBe(false);
    expect(r.captions[1].fill).toEqual([1, 1, 1]);
    expect(r.captions[1].faux_italic).toBe(true);
  });

  it("a re-run with no colours puts the base style back on a layer that was coloured", () => {
    const { comp, A } = scene();
    apply(A, comp, { captions: coloured.map((c) => ({ ...c, color: RED })) });
    expect(docOf(comp.layer("Caption 002")!).fillColor).toEqual(RED);
    // Only caption 1 keeps a colour: caption 2 goes back to the style's fill.
    apply(A, comp, { captions: coloured.map((c, i) => ({ ...c, color: i === 0 ? RED : null })) });
    expect(docOf(comp.layer("Caption 001")!).fillColor).toEqual(RED);
    expect(docOf(comp.layer("Caption 002")!).fillColor).toEqual([1, 1, 1]);
    // No caption carries a colour at all: a layer the tool coloured earlier goes back to the style's fill.
    const plain = CAPS.map((c) => ({ start: c.start, end: c.end, lines: c.lines }));
    apply(A, comp, { captions: plain });
    expect(docOf(comp.layer("Caption 001")!).fillColor).toEqual([1, 1, 1]);
    apply(A, comp, { captions: plain, restyle: true });
    expect(docOf(comp.layer("Caption 001")!).fillColor).toEqual([1, 1, 1]);
  });

  it("a plain re-run clears a lyric italic and a speaker colour the tool wrote, and leaves a hand-set fill alone", () => {
    const { comp, A } = scene();
    apply(A, comp, { captions: coloured.map((c) => ({ ...c, color: RED, italic: true })) });
    expect(docOf(comp.layer("Caption 001")!).fauxItalic).toBe(true);
    const plain = CAPS.map((c) => ({ start: c.start, end: c.end, lines: c.lines }));
    apply(A, comp, { captions: plain });
    expect(docOf(comp.layer("Caption 001")!).fauxItalic).toBe(false);
    expect(docOf(comp.layer("Caption 002")!).fillColor).toEqual([1, 1, 1]);
    // The tool has no colour history now, so a fill the user sets stays through another plain run.
    const d = docOf(comp.layer("Caption 001")!);
    d.fillColor = [0, 1, 0];
    ((comp.layer("Caption 001")!.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).setValue(d);
    apply(A, comp, { captions: plain });
    expect(docOf(comp.layer("Caption 001")!).fillColor).toEqual([0, 1, 0]);
  });

  it("single: each Source Text key keeps its own fill and italic", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "single", captions: coloured });
    const src = (comp.layer("Caption")!.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty;
    const keyDocs = src.keys.map((k) => k.value as TextDocument);
    // Two captions with a gap between them: text, blank, text, blank.
    expect(keyDocs.map((d) => d.text)).toEqual(["Hello\rthere".replace("\r", " "), "", "Second\rcaption here", ""]);
    expect(keyDocs[0].fillColor).toEqual(RED);
    expect(keyDocs[2].fillColor).toEqual([1, 1, 1]);
    expect((keyDocs[2] as any).fauxItalic).toBe(true);
    const r = read(A, comp, { mode: "single" });
    expect(r.captions[0].keys[0].fill).toEqual(RED);
    expect(r.captions[0].keys[2].faux_italic).toBe(true);
  });

  it("words: every word layer of a caption takes its colour", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words", captions: [CAPS[0], CAPS[1]].map((c, i) => ({ ...c, color: i === 0 ? RED : null, italic: i === 1 })) });
    expect(docOf(comp.layer("Caption 001.01")!).fillColor).toEqual(RED);
    expect(docOf(comp.layer("Caption 001.02")!).fillColor).toEqual(RED);
    expect(docOf(comp.layer("Caption 002.03")!).fillColor).toEqual([1, 1, 1]);
    expect((docOf(comp.layer("Caption 002.01")!) as any).fauxItalic).toBe(true);
    const r = read(A, comp, { mode: "words" });
    expect(r.captions[0].fill).toEqual(RED);
    expect(r.captions[0].words.map((w: any) => w.fill)).toEqual([RED, RED]);
    expect(r.captions[1].words.every((w: any) => w.faux_italic === true)).toBe(true);
  });

  it("a colour outside 0..1 is refused before anything is written", () => {
    const { comp, A, undo } = scene();
    expect(kind(() => apply(A, comp, { captions: [cap(0.4, 2, ["Hi"], undefined, { color: [2, 0, 0] })] }))).toBe("bad_args");
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(0);
  });
});

// ---------- pop ----------

describe("look pop", () => {
  it("layers: three animators on the caption, Start keyed per word in Index units, Based On Words", () => {
    const { comp, A, undo } = scene();
    const out = apply(A, comp, { look: "pop" });
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    const l = comp.layer("Caption 001")!;
    expect(animators(l).map((a) => a.name)).toEqual(["Caption Look", "Caption Look Scale", "Caption Look Overshoot"]);
    const main = selOf(animators(l)[0]);
    expect(sp(main, "ADBE Text Range Units").value).toBe(2);
    expect(sp(main, "ADBE Text Range Type2").value).toBe(3);
    expect(sp(main, "ADBE Text Index End").value).toBe(2);
    // Opacity ramp over a third of 6 frames (0.08 s): word 1 from 0.4, word 2 from 1.2.
    expect(keysOf(sp(main, "ADBE Text Index Start"))).toEqual([[0.4, 0], [0.48, 1], [1.2, 1], [1.28, 2]]);
    const scale = selOf(animators(l)[1]);
    // Scale over 60% of 0.24 s = 0.144 s.
    expect(keysOf(sp(scale, "ADBE Text Index Start"))).toEqual([[0.4, 0], [0.544, 1], [1.2, 1], [1.344, 2]]);
    expect(((animators(l)[1].property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Scale 3D") as FakeProperty).value).toEqual([80, 80, 80]);
    expect(((animators(l)[0].property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Opacity") as FakeProperty).value).toBe(0);
    // The overshoot: 106% at 60% of the duration (amount keyed 0, 100, 0 per word), its window on the active word.
    const over = selOf(animators(l)[2]);
    expect(((animators(l)[2].property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Scale 3D") as FakeProperty).value).toEqual([106, 106, 106]);
    expect(keysOf(sp(over, "ADBE Text Selector Max Amount")).map((k) => k[1])).toEqual([0, 100, 0, 0, 100, 0]);
    expect(keysOf(sp(over, "ADBE Text Index Start")).map((k) => k[1])).toEqual([0, 1]);
    expect(keysOf(sp(over, "ADBE Text Index End")).map((k) => k[1])).toEqual([1, 2]);
    expect(out.look).toEqual({ kind: "pop", layers: 2, keys: 10, duration_frames: 6 });
    expect(read(A, comp).captions[0].look).toEqual({ present: true, kind: "pop", keys: 4 });
  });

  it("look_options change the duration and the starting scale", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pop", look_options: { duration_frames: 10, scale_from: 50 } });
    const l = comp.layer("Caption 001")!;
    const main = selOf(animators(l)[0]);
    // 10 frames = 0.4 s; the opacity ramp is a third of it.
    expect(keysOf(sp(main, "ADBE Text Index Start"))[1][0]).toBeCloseTo(0.4 + 0.4 / 3, 6);
    expect(((animators(l)[1].property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Scale 3D") as FakeProperty).value).toEqual([50, 50, 50]);
    expect(((animators(l)[2].property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Scale 3D") as FakeProperty).value).toEqual([115, 115, 115]);
  });

  it("a re-run rebuilds the animators instead of stacking them, and look none takes them off", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pop" });
    apply(A, comp, { look: "pop" });
    expect(animators(comp.layer("Caption 001")!).length).toBe(3);
    const out = apply(A, comp, {});
    expect(animators(comp.layer("Caption 001")!).length).toBe(0);
    expect(out.looks_removed).toBe(2);
    expect(read(A, comp).captions[0].look).toEqual({ present: false });
  });

  it("keeps the highlight animator working beside it", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pop", highlight: { color: [1, 1, 0] } });
    expect(animators(comp.layer("Caption 001")!).map((a) => a.name)).toEqual(["Caption Highlight", "Caption Look", "Caption Look Scale", "Caption Look Overshoot"]);
    // Taking the look off leaves the highlight.
    apply(A, comp, { highlight: { color: [1, 1, 0] } });
    expect(animators(comp.layer("Caption 001")!).map((a) => a.name)).toEqual(["Caption Highlight"]);
  });

  it("words: Scale and Opacity keys on each word layer from its time, anchored at the word's middle, marked in the comment", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { mode: "words", look: "pop" });
    const w2 = comp.layer("Caption 001.02")!;
    const scale = keysOf(w2.transform("Scale"));
    expect(scale.map((k) => k[0])).toEqual([1.2, 1.344, 1.44]);
    expect(scale.map((k) => k[1])).toEqual([[80, 80, 100], [106, 106, 100], [100, 100, 100]]);
    expect(keysOf(w2.transform("Opacity"))).toEqual([[1.2, 0], [1.28, 100]]);
    expect(w2.comment).toMatch(/(^|;)chroma-ae caption look:pop$/);
    // Half of the 5-character word (162.5 wide) and half its 78 px height from the origin.
    expect((w2.transform("Anchor Point").value as number[]).slice(0, 2)).toEqual([81.25, -26]);
    expect(out.look).toEqual({ kind: "pop", layers: 2, keys: 15, duration_frames: 6 });
    const r = read(A, comp, { mode: "words" });
    expect(r.captions[0].look).toMatchObject({ present: true, kind: "pop", layers: 2 });
  });

  it("words: the layout still puts each word where it was, anchor or not, and look none restores the layers", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words" });
    const before = (comp.layer("Caption 001.02")!.transform("Position").value as number[]).slice(0, 2);
    apply(A, comp, { mode: "words", look: "pop" });
    const p = comp.layer("Caption 001.02")!;
    const anc = p.transform("Anchor Point").value as number[];
    const pos = p.transform("Position").value as number[];
    expect([pos[0] - anc[0], pos[1] - anc[1]]).toEqual(before);
    // A relayout (restyle) with the anchor moved keeps the origin where the layout puts it.
    apply(A, comp, { mode: "words", look: "pop", restyle: true });
    const pos2 = comp.layer("Caption 001.02")!.transform("Position").value as number[];
    const anc2 = comp.layer("Caption 001.02")!.transform("Anchor Point").value as number[];
    expect([pos2[0] - anc2[0], pos2[1] - anc2[1]]).toEqual(before);
    const out = apply(A, comp, { mode: "words" });
    expect(p.transform("Scale").numKeys).toBe(0);
    expect(p.transform("Scale").value).toEqual([100, 100, 100]);
    expect(p.transform("Opacity").numKeys).toBe(0);
    expect(p.comment).not.toMatch(/look:/);
    expect(out.looks_removed).toBe(2);
  });
});

// ---------- fill sweep ----------

describe("look fill_sweep", () => {
  it("layers: a Fill Color animator whose End runs through the characters of each word while it is said", () => {
    const { comp, A } = scene();
    const out = apply(A, comp, { look: "fill_sweep" });
    const l = comp.layer("Caption 001")!;
    expect(animators(l).map((a) => a.name)).toEqual(["Caption Look"]);
    const a = animators(l)[0];
    expect(((a.property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Fill Color") as FakeProperty).value).toEqual([1, 0.85, 0]);
    const sel = selOf(a);
    expect(sp(sel, "ADBE Text Range Units").value).toBe(2);
    expect(sp(sel, "ADBE Text Range Type2").value).toBe(2);
    // "Hello" (5 characters) from 0.4 to 0.8, "there" (5) from 1.2 to 1.8.
    expect(keysOf(sp(sel, "ADBE Text Index End"))).toEqual([[0.4, 0], [0.8, 5], [1.2, 5], [1.8, 10]]);
    expect(out.look.kind).toBe("fill_sweep");
    expect(read(A, comp).captions[0].look).toEqual({ present: true, kind: "fill_sweep", keys: 4 });
  });

  it("takes look_options.color", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "fill_sweep", look_options: { color: [0, 1, 0] } });
    const a = animators(comp.layer("Caption 002")!)[0];
    expect(((a.property("ADBE Text Animator Properties") as FakeGroup).property("ADBE Text Fill Color") as FakeProperty).value).toEqual([0, 1, 0]);
    // Six non-space characters in "Second", then "caption" (7) and "here" (4).
    expect(keysOf(sp(selOf(a), "ADBE Text Index End")).map((k) => k[1])).toEqual([0, 6, 6, 13, 17]);
  });

  it("words: a Fill Color animator on each word layer, End keyed 0 to 100 percent over the word", () => {
    const { comp, A } = scene();
    apply(A, comp, { mode: "words", look: "fill_sweep" });
    const w = comp.layer("Caption 001.02")!;
    const a = animators(w)[0];
    expect(a.name).toBe("Caption Look");
    const sel = selOf(a);
    expect(sp(sel, "ADBE Text Range Units").value).toBe(1);
    expect(keysOf(sp(sel, "ADBE Text Percent End"))).toEqual([[1.2, 0], [1.8, 100]]);
    const r = read(A, comp, { mode: "words" });
    expect(r.captions[0].look).toMatchObject({ present: true, kind: "fill_sweep", keys: 4 });
    apply(A, comp, { mode: "words" });
    expect(animators(w).length).toBe(0);
  });
});

// ---------- pill ----------

describe("look pill_slide", () => {
  it("layers: a shape layer under the caption, parented to it, its rectangle keyed to each word", () => {
    const { comp, A, undo } = scene();
    const out = apply(A, comp, { look: "pill_slide" });
    expect(undo.begun).toBe(1);
    const pill = comp.layer("Caption 001 Look")!;
    expect(pill.reflect.name).toBe("ShapeLayer");
    expect(pill.parent?.name).toBe("Caption 001");
    expect(names(comp).indexOf("Caption 001 Look")).toBe(names(comp).indexOf("Caption 001") + 1);
    expect(pill.inPoint).toBeCloseTo(0.4, 6);
    expect(pill.outPoint).toBeCloseTo(2, 6);
    // Font 65, half a size per character: "Hello" and "there" are 162.5 wide, a space 32.5; centred, the line is 357.5 wide.
    // Padding 8 px (12% of 65), ease 4 frames (0.16 s).
    const pos = keysOf(pillProp(pill, "ADBE Vector Rect Position"));
    expect(pos.map((k) => k[0])).toEqual([0.4, 1.04, 1.2]);
    expect(pos.map((k) => k[1])).toEqual([[-97.5, -26], [-97.5, -26], [97.5, -26]]);
    const size = keysOf(pillProp(pill, "ADBE Vector Rect Size"));
    expect(size[0][1]).toEqual([178.5, 94]);
    expect((pillRect(pill).property("ADBE Vector Graphic - Fill") as FakeGroup).property("ADBE Vector Fill Color")).toBeTruthy();
    expect(((pillRect(pill).property("ADBE Vector Graphic - Fill") as FakeGroup).property("ADBE Vector Fill Color") as FakeProperty).value).toEqual([1, 0.8, 0, 1]);
    expect(out.created).toContain("Caption 001 Look");
    // Two lines: the second caption's pill sits a leading (78 px) lower on its second line.
    const pos2 = keysOf(pillProp(comp.layer("Caption 002 Look")!, "ADBE Vector Rect Position"));
    expect((pos2[pos2.length - 1][1] as number[])[1]).toBe(52);
    expect((pos2[0][1] as number[])[1]).toBe(-26);
    expect(read(A, comp).captions[0].look).toEqual({ present: true, kind: "pill_slide", keys: 3 });
    // The caption's text is back as it was after the measuring.
    expect(docOf(comp.layer("Caption 001")!).text).toBe("Hello there");
  });

  it("take look_options for padding, roundness, colour and the slide time", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pill_slide", look_options: { pill_padding: 20, pill_roundness: 30, color: [0, 0.5, 1], duration_frames: 10 } });
    const pill = comp.layer("Caption 001 Look")!;
    expect(keysOf(pillProp(pill, "ADBE Vector Rect Size"))[0][1]).toEqual([202.5, 118]);
    expect(pillProp(pill, "ADBE Vector Rect Roundness").value).toBe(30);
    expect(keysOf(pillProp(pill, "ADBE Vector Rect Position"))[1][0]).toBeCloseTo(0.8, 6);
  });

  it("a re-run makes the pill again (one layer, not two), and look none removes it", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pill_slide" });
    const again = apply(A, comp, { look: "pill_slide" });
    expect(names(comp).filter((n) => n === "Caption 001 Look").length).toBe(1);
    expect(again.updated).toContain("Caption 001 Look");
    const out = apply(A, comp, {});
    expect(names(comp).filter((n) => n.endsWith(" Look")).length).toBe(0);
    expect(out.removed).toEqual(expect.arrayContaining(["Caption 001 Look", "Caption 002 Look"]));
    expect(out.looks_removed).toBe(2);
    expect(read(A, comp).captions[0].look).toEqual({ present: false });
  });

  it("fewer captions on a re-run remove the stale captions' pills too", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pill_slide" });
    apply(A, comp, { look: "pill_slide", captions: [CAPS[0]] });
    expect(names(comp).filter((n) => n.startsWith("Caption 002"))).toEqual([]);
  });

  it("parent_to_null parents the captions to the control; each pill stays with its caption", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pill_slide", parent_to_null: true });
    expect(comp.layer("Caption 001")!.parent?.name).toBe("Caption Control");
    expect(comp.layer("Caption 001 Look")!.parent?.name).toBe("Caption 001");
  });

  it("precompose takes the pills with the captions", () => {
    const { comp, A, project } = scene();
    const out = apply(A, comp, { look: "pill_slide", precompose: true });
    const inner = project.itemByID(out.precomp.comp_id) as FakeComp;
    expect(inner.stack.map((l) => l.name).sort()).toEqual(["Caption 001", "Caption 001 Look", "Caption 002", "Caption 002 Look"]);
  });

  it("words: one pill per caption, in comp space, keyed to each word layer's rect, below the word layers", () => {
    const { comp, A, undo } = scene();
    apply(A, comp, { mode: "words", look: "pill_slide" });
    expect(undo.begun).toBe(1);
    const pill = comp.layer("Caption 001 Look")!;
    expect(pill.parent).toBeNull();
    const idx = (n: string) => names(comp).indexOf(n);
    expect(idx("Caption 001 Look")).toBeGreaterThan(Math.max(idx("Caption 001.01"), idx("Caption 001.02")));
    const w1 = comp.layer("Caption 001.01")!;
    const w2 = comp.layer("Caption 001.02")!;
    const pos = keysOf(pillProp(pill, "ADBE Vector Rect Position"));
    expect(pos.length).toBe(3);
    const x1 = (w1.transform("Position").value as number[])[0];
    const x2 = (w2.transform("Position").value as number[])[0];
    expect((pos[0][1] as number[])[0]).toBeCloseTo(x1 + 81.25, 6);
    expect((pos[2][1] as number[])[0]).toBeCloseTo(x2 + 81.25, 6);
    expect(pill.inPoint).toBeCloseTo(0.4, 6);
    expect(pill.outPoint).toBeCloseTo(2, 6);
    const r = read(A, comp, { mode: "words" });
    expect(r.captions[0].look).toMatchObject({ present: true, kind: "pill_slide", keys: 3 });
    apply(A, comp, { mode: "words" });
    expect(names(comp).filter((n) => n.endsWith(" Look"))).toEqual([]);
  });
});

// ---------- refusals ----------

describe("looks: refusals before anything is written", () => {
  it("single and template modes", () => {
    const { comp, A, undo, project } = scene();
    expect(message(() => apply(A, comp, { mode: "single", look: "pop" }))).toMatch(/layers and words modes/);
    const tplComp = project.addComp("Lower third", 640, 360, 4);
    tplComp.controllers = ["Line 1"];
    expect(message(() => apply(A, comp, { mode: "template", look: "pop", template: { comp_id: tplComp.id, fields: { "Line 1": "line1" } } }))).toMatch(/layers and words modes/);
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("fill_sweep together with highlight", () => {
    const { comp, A, undo } = scene();
    expect(message(() => apply(A, comp, { look: "fill_sweep", highlight: { color: [1, 1, 0] } }))).toMatch(/both colour the spoken words/);
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("an unknown look, bad options, look_options without a look, a caption without its word times, pill with a paragraph box", () => {
    const { comp, A } = scene();
    expect(message(() => apply(A, comp, { look: "wobble" }))).toMatch(/look must be/);
    expect(message(() => apply(A, comp, { look: "pop", look_options: { duration_frames: 31 } }))).toMatch(/duration_frames/);
    expect(message(() => apply(A, comp, { look: "pop", look_options: { scale_from: 300 } }))).toMatch(/scale_from/);
    expect(message(() => apply(A, comp, { look: "fill_sweep", look_options: { color: [1, 2, 0] } }))).toMatch(/look_options.color/);
    expect(message(() => apply(A, comp, { look_options: { duration_frames: 4 } }))).toMatch(/need a look/);
    expect(message(() => apply(A, comp, { look: "pop", captions: [cap(0.4, 2, ["Hello there"])] }))).toMatch(/needs one per word/);
    expect(message(() => apply(A, comp, { look: "pill_slide", style: { text_box: {} } }))).toMatch(/paragraph/);
    expect(comp.numLayers).toBe(0);
  });

  it("an existing pill that is not a shape layer, or is locked", () => {
    const { comp, A } = scene();
    apply(A, comp, { look: "pill_slide" });
    comp.layer("Caption 001 Look")!.locked = true;
    expect(message(() => apply(A, comp, { look: "pill_slide" }))).toMatch(/locked/);
  });
});

// ---------- caption template ----------

describe("captionsTemplate", () => {
  const tpl = (A: any, comp: FakeComp, extra: Record<string, unknown> = {}) =>
    A.captionsTemplate({ comp_id: comp.id, make_template: { name: "Cap Template" }, default_margins: CAPTION_DEFAULT_MARGINS, expect: GUARD, ...extra });

  it("makes a comp with the caption layer and adds its text and colour to Essential Graphics", () => {
    const { comp, A, project, undo } = scene();
    const out = tpl(A, comp, { style: { font_size: 80, fill_color: [1, 0.9, 0] } });
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    const made = project.itemByID(out.comp_id) as FakeComp;
    expect(made.name).toBe("Cap Template");
    expect([made.width, made.height, made.duration, made.frameRate]).toEqual([1080, 1920, 5, 25]);
    expect(out.controllers).toEqual(["Caption Text", "Caption Color"]);
    expect(out.controllers_named).toBe(true);
    expect(made.controllers).toEqual(["Caption Text", "Caption Color"]);
    expect(made.motionGraphicsTemplateName).toBe("Cap Template");
    const text = made.layer("Caption")!;
    expect(docOf(text).text).toBe("Caption text");
    expect(docOf(text).fontSize).toBe(80);
    const fx = (text.property("ADBE Effect Parade") as FakeGroup).property("ADBE Fill") as FakeGroup;
    expect((fx.property("ADBE Fill-0002") as FakeProperty).value).toEqual([1, 0.9, 0, 1]);
    // Nothing went into the target comp.
    expect(comp.numLayers).toBe(0);
    const back = A.captionsTemplateRead({ comp_id: out.comp_id });
    expect(back.controllers).toEqual(["Caption Text", "Caption Color"]);
    expect(back.layers).toEqual([expect.objectContaining({ name: "Caption", kind: "text", text: "Caption text", has_fill_effect: true })]);
  });

  it("sizes the text like ae_captions would for the target comp, not for a small template comp, and makes the comp tall enough for its lines", () => {
    const { comp: wide, A, project } = scene(1920, 1080);
    const out = tpl(A, wide, { make_template: { name: "Small", width: 800, height: 120 } });
    const made = project.itemByID(out.comp_id) as FakeComp;
    // 6% of the 1080 short side, as the layers mode default; not 6% of the 120 px comp (7 px).
    expect(docOf(made.layer("Caption")!).fontSize).toBe(65);
    expect(out.font_size).toBe(65);
    // Two lines at 65 px (78 px leading) plus room: the comp was grown, with a warning.
    expect(made.height).toBeGreaterThanOrEqual(2 * 78 + 65);
    expect(out.warnings.join(" ")).toContain("too small for 2 lines");
    expect(out.lines).toBe(2);
    // The first baseline leaves room for the two lines under it inside the comp.
    const y = (made.layer("Caption")!.transform("Position").value as number[])[1];
    expect(y + 78 + 65 * 0.25).toBeLessThanOrEqual(made.height + 1e-6);
    // An explicit size wins.
    const big = tpl(A, wide, { style: { font_size: 90 }, make_template: { name: "Big" } });
    expect(big.font_size).toBe(90);
  });

  it("with a box: the box colour and opacity are controllers too, and the opacity is a plain value", () => {
    const { comp, A, project } = scene();
    const out = tpl(A, comp, { box: { color: [0, 0, 0], opacity: 55, padding: 20, roundness: 12 }, make_template: { name: "Boxed", width: 1920, height: 1080, duration_s: 8 } });
    const made = project.itemByID(out.comp_id) as FakeComp;
    expect([made.width, made.height, made.duration]).toEqual([1920, 1080, 8]);
    expect(out.controllers).toEqual(["Caption Text", "Caption Color", "Box Color", "Box Opacity"]);
    const box = made.layer("Caption Box")!;
    const op = box.transform("Opacity");
    expect(op.value).toBe(55);
    expect(op.expression).toBe("");
    // The size and position still follow the text.
    expect(pillProp(box, "ADBE Vector Rect Size").expression).toContain("sourceRectAtTime");
    expect(A.captionsTemplateRead({ comp_id: out.comp_id }).layers.map((l: any) => l.name)).toEqual(["Caption", "Caption Box"]);
  });

  it("pop: the text layer pops in from its in point", () => {
    const { comp, A, project } = scene();
    const out = tpl(A, comp, { look: "pop", look_options: { scale_from: 70 } });
    const text = (project.itemByID(out.comp_id) as FakeComp).layer("Caption")!;
    expect(text.transform("Scale").numKeys).toBe(3);
    expect((text.transform("Scale").keys[0].value as number[])[0]).toBe(70);
    expect(text.comment).toBe("chroma-ae caption look:pop");
    expect(out.look).toBe("pop");
  });

  it("falls back to the AE-chosen names where there is no addToMotionGraphicsTemplateAs", () => {
    const { comp, A, project } = scene();
    const saved = FakeProperty.prototype.addToMotionGraphicsTemplateAs;
    (FakeProperty.prototype as any).addToMotionGraphicsTemplateAs = undefined;
    try {
      const out = tpl(A, comp);
      expect(out.controllers_named).toBe(false);
      expect(out.controllers).toEqual(["Source Text", "Color"]);
      expect((project.itemByID(out.comp_id) as FakeComp).controllers.length).toBe(2);
    } finally {
      FakeProperty.prototype.addToMotionGraphicsTemplateAs = saved;
    }
  });

  it("refuses, before making a comp, a look it cannot do, a bad size or a box with no room", () => {
    const { comp, A, project, undo } = scene();
    const before = project.numItems;
    expect(message(() => tpl(A, comp, { look: "pill_slide" }))).toMatch(/none or pop/);
    expect(message(() => tpl(A, comp, { make_template: { name: "X", width: 2 } }))).toMatch(/width/);
    expect(message(() => tpl(A, comp, { make_template: { name: "" } }))).toMatch(/name/);
    expect(message(() => tpl(A, comp, { box: { color: [0, 0, 0], opacity: 50, padding: 5000, roundness: 0 } }))).toMatch(/padding/);
    expect(message(() => tpl(A, comp, { style: { text_box: { width: 100 } } }))).toMatch(/point text/);
    expect(project.numItems).toBe(before);
    expect(undo.begun).toBe(0);
  });

  it("a failed Essential Graphics add takes the new comp back", () => {
    const { comp, A, project } = scene();
    const saved = FakeProperty.prototype.canAddToMotionGraphicsTemplate;
    (FakeProperty.prototype as any).canAddToMotionGraphicsTemplate = () => false;
    const before = project.numItems;
    try {
      expect(kind(() => tpl(A, comp))).toBe("runtime");
    } finally {
      FakeProperty.prototype.canAddToMotionGraphicsTemplate = saved;
    }
    expect(project.numItems).toBe(before);
  });
});
