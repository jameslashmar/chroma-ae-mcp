import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTION_DEFAULT_MARGINS } from "../src/tools/ext/captions.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, TextDocument, loadHost, type FakeComp } from "./support/fake-ae.js";

// Regression: a words-mode re-run that re-chunks the transcript (max_words 3 -> 4) garbled the render, because
// reused word layers were measured with sourceRectAtTime in the script that changed their text, and AE answers that
// with the previous text's rectangle. The fake models it: a text layer that existed before the script reads the
// rectangle of the text it had when the script began.

const origRect = FakeLayer.prototype.sourceRectAtTime;
const origSetValue = FakeProperty.prototype.setValue;
const copyDoc = (v: unknown) => (v instanceof TextDocument ? Object.assign(new TextDocument(v.text), v) : v);
const textDoc = (l: FakeLayer) => ((l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).value as TextDocument;
let snapshot: Map<FakeLayer, TextDocument> | null = null;
/** Starts a new evalScript: every text layer now in the comp is "old" and reads stale text until the next one. */
const nextScript = (comp: FakeComp) => {
  snapshot = new Map();
  for (const l of comp.stack) if (l.reflect.name === "TextLayer") snapshot.set(l, Object.assign(new TextDocument(textDoc(l).text), textDoc(l)));
};

beforeAll(() => {
  (FakeProperty.prototype as any).setValue = function (this: FakeProperty, v: unknown) {
    return origSetValue.call(this, copyDoc(v));
  };
  (FakeLayer.prototype as any).sourceRectAtTime = function (this: FakeLayer) {
    if (this.reflect.name !== "TextLayer") return origRect.call(this);
    const d = snapshot?.get(this) ?? textDoc(this);
    const lines = String(d.text).split("\r");
    const widest = Math.max(...lines.map((l) => l.length));
    return { left: 0, top: -d.fontSize, width: widest * d.fontSize * 0.5, height: lines.length * d.fontSize * 1.2 };
  };
});
afterAll(() => {
  FakeProperty.prototype.setValue = origSetValue;
  FakeLayer.prototype.sourceRectAtTime = origRect;
  snapshot = null;
});

const WORDS = "shipping it was hard and then the client approved it on the twelfth day".split(" ");
const WT = 0.3;
const chunk = (n: number) => {
  const caps: any[] = [];
  for (let i = 0; i < WORDS.length; i += n) {
    const ws = WORDS.slice(i, i + n);
    const start = i * WT;
    const end = (i + ws.length) * WT;
    const half = Math.ceil(ws.length / 2);
    caps.push({ start, end, lines: ws.length > 2 ? [ws.slice(0, half).join(" "), ws.slice(half).join(" ")] : [ws.join(" ")], words: ws.map((_, k) => ({ start: start + k * WT, end: start + (k + 1) * WT })) });
  }
  return caps;
};

function scene() {
  const project = new FakeProject();
  project.strictRefs = true;
  const comp = project.addComp("Vertical", 1080, 1920, 20);
  comp.frameRate = 30;
  const host = loadHost(project, ["captions.jsx"]);
  host.G.ParagraphJustification = { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7414, RIGHT_JUSTIFY: 7415 };
  return { project, comp, ...host };
}
const apply = (A: any, comp: FakeComp, captions: any[]) => {
  nextScript(comp);
  const r = A.captionsApply({ comp_id: comp.id, mode: "words", name_prefix: "Caption", first_number: 1, captions, look: "pop", parent_to_null: true, default_margins: CAPTION_DEFAULT_MARGINS, expect: GUARD });
  snapshot = null;
  return r;
};
const wordLayers = (c: FakeComp) => c.stack.filter((l) => /^Caption \d+\.\d+$/.test(l.name));
const posOf = (l: FakeLayer) => (l.property("ADBE Transform Group") as FakeGroup).property("ADBE Position") as FakeProperty;
const state = (c: FakeComp) =>
  Object.fromEntries(wordLayers(c).map((l) => [l.name, { text: textDoc(l).text, pos: posOf(l).value, in: l.inPoint, out: l.outPoint, parent: l.parent?.name ?? null }]));

describe("words mode: re-chunking an existing build", () => {
  it("lays out like a fresh build, with no word layer of an old caption alive in another caption's time", () => {
    const a = scene();
    apply(a.A, a.comp, chunk(3));
    const first = wordLayers(a.comp).length;
    expect(first).toBe(WORDS.length);
    const res = apply(a.A, a.comp, chunk(4));

    const fresh = scene();
    apply(fresh.A, fresh.comp, chunk(4));
    const got = state(a.comp);
    const want = state(fresh.comp);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) {
      expect(got[k].text).toBe(want[k].text);
      expect(got[k].pos).toEqual(want[k].pos);
      expect(got[k].in).toBeCloseTo(want[k].in, 6);
      expect(got[k].out).toBeCloseTo(want[k].out, 6);
      expect(got[k].parent).toBe(want[k].parent);
    }
    // At every sample time, only the words of the caption that owns that time are visible.
    const caps = chunk(4);
    for (let f = 0; f < WORDS.length * WT * 30; f++) {
      const t = (f + 0.5) / 30;
      const owner = caps.findIndex((c) => t >= c.start && t < c.end) + 1;
      for (const l of wordLayers(a.comp)) {
        if (t >= l.inPoint && t < l.outPoint) expect(Number(l.name.slice(8, 11))).toBe(owner);
      }
    }
    // The counts stay truthful: what the call lists as created/removed is what happened to the stack.
    expect(res.created.length - res.removed.filter((n: string) => /\.\d+$/.test(n)).length).toBe(wordLayers(a.comp).length - first);
    expect(wordLayers(a.comp).length).toBe(WORDS.length);
  });

  it("an identical re-run keeps the word layers (nothing removed) and a repeat equals the fresh build", () => {
    const a = scene();
    apply(a.A, a.comp, chunk(4));
    const ids = wordLayers(a.comp).map((l) => l.id);
    const res = apply(a.A, a.comp, chunk(4));
    expect(res.removed.filter((n: string) => /\.\d+$/.test(n))).toEqual([]);
    expect(wordLayers(a.comp).map((l) => l.id)).toEqual(ids);
  });
});
