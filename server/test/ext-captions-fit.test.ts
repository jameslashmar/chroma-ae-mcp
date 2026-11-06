import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { availableWidth, DESCENDER_SHARE, isTooWide, outsideReason, rebreakLines, shrinkSize } from "../src/caption-fit.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeCaptionsSchema, captionsTools, templateMaxLines } from "../src/tools/ext/captions.js";
import { captionsioTools, AeCaptionsQaSchema } from "../src/tools/ext/captionsio.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, PropertyValueType, TextDocument, loadHost, type FakeComp } from "./support/fake-ae.js";

// ae_captions fit: the Node tool driving the real host JSX over the fake After Effects, so the measure (separate
// evalScript), the re-break, the shrink and the read-back all run. Text measures at `PX` pixels per character per
// point of font size, so a "very wide display face" is a big PX.

const origAdd = FakeGroup.prototype.addProperty;
const origSet = FakeProperty.prototype.setValueAtTime;
const origSetValue = FakeProperty.prototype.setValue;
const origRect = FakeLayer.prototype.sourceRectAtTime;
const copyDoc = (v: unknown) => (v instanceof TextDocument ? Object.assign(new TextDocument(v.text), v) : v);
let PX = 0.9;

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
  (FakeLayer.prototype as any).sourceRectAtTime = function (this: FakeLayer, t: number) {
    if (this.reflect.name !== "TextLayer") return origRect.call(this);
    const prop = (this.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty;
    // The fake interpolates text documents between keys; a hold key is its own value at its time.
    const hit = prop.keys.find((k) => Math.abs(k.time - t) < 1e-6) ?? [...prop.keys].reverse().find((k) => k.time <= t) ?? prop.keys[0];
    const d = (hit ? hit.value : prop.value) as TextDocument;
    const lines = String(d.text).split("\r");
    const widest = Math.max(...lines.map((l) => l.length));
    return { left: -(widest * d.fontSize * PX) / 2, top: -d.fontSize, width: widest * d.fontSize * PX, height: lines.length * d.fontSize * 1.2 };
  };
});
afterAll(() => {
  FakeGroup.prototype.addProperty = origAdd;
  FakeProperty.prototype.setValueAtTime = origSet;
  FakeProperty.prototype.setValue = origSetValue;
  FakeLayer.prototype.sourceRectAtTime = origRect;
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function scene(width = 1920, height = 1080) {
  const project = new FakeProject();
  const comp = project.addComp("Main", width, height, 30);
  comp.frameRate = 25;
  const host = loadHost(project, ["captions.jsx"]);
  host.G.ParagraphJustification = { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7414, RIGHT_JUSTIFY: 7415 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fit-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const calls: string[] = [];
  const bridge = new PanelHost({
    evalScript: async (script) => {
      const m = /^__chromaAe\.(\w+)\(([\s\S]*)\)$/.exec(script)!;
      calls.push(m[1]);
      if (m[1] === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: comp.id, comp_is_valid: true }, durationMs: 1 };
      const out = host.G.__chromaAe[m[1]](JSON.parse(m[2]));
      return { ok: true, result: JSON.parse(JSON.stringify(out ?? null)), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge, queue, quarantine };
  return { project, comp, ctx, calls, ...host };
}

const words = (text: string, step = 0.4) =>
  JSON.stringify({ words: text.split(" ").map((w, i) => ({ text: w, start: 0.5 + i * step, end: 0.5 + i * step + step * 0.9, type: "word" })) });

const run = (ctx: ToolContext, extra: Record<string, unknown>) =>
  captionsTools.find((t) => t.name === "ae_captions")!.handler(
    AeCaptionsSchema.parse({ comp_id: extra.comp_id, expect: { project_path: "<unsaved>" }, ...extra }),
    ctx
  );
const doc = (l: FakeLayer) => ((l.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).value as TextDocument;
const widthOf = (l: FakeLayer) => l.sourceRectAtTime(0, false).width;

// ---------- the arithmetic ----------

describe("caption-fit helpers", () => {
  const area = { comp_width: 1920, left: 96, right: 96, width: 1728, justification: "center" as const };
  it("centred text must fit the narrower margin; a box takes its padding off both sides", () => {
    expect(availableWidth(area)).toBe(1728);
    expect(availableWidth({ ...area, left: 100, right: 300 })).toBe(1920 - 600);
    expect(availableWidth({ ...area, justification: "left", left: 100, right: 300, width: 1520 })).toBe(1520);
    expect(availableWidth({ ...area, box_padding: 24 })).toBe(1728 - 48);
  });

  it("rebreakLines uses the measured pixels per character and refuses what cannot work", () => {
    const c = { index: 1, name: "Caption 001", width: 2340, font_size: 65, lines: ["Our new studio opens in London next week"] };
    expect(isTooWide(c, area)).toBe(true);
    const lines = rebreakLines(c, area, 2)!;
    expect(lines).toHaveLength(2);
    expect(lines.join(" ")).toBe(c.lines[0]);
    for (const l of lines) expect(l.length * 58.5).toBeLessThanOrEqual(1728);
    // One line allowed: nothing to do. A word wider than the space: nothing to do.
    expect(rebreakLines(c, area, 1)).toBeNull();
    expect(rebreakLines({ ...c, lines: ["Supercalifragilisticexpialidocious"], width: 1989 }, area, 2)).toBeNull();
  });

  it("shrinkSize scales to fit, floors at 70% of the base, and says when that still does not fit", () => {
    const area2 = { ...area };
    expect(shrinkSize({ index: 1, name: "c", width: 1989, font_size: 65, lines: ["x"] }, area2, 65)).toEqual({ font_size: 56, fits: true });
    expect(shrinkSize({ index: 1, name: "c", width: 3000, font_size: 65, lines: ["x"] }, area2, 65)).toEqual({ font_size: 46, fits: false });
    expect(shrinkSize({ index: 1, name: "c", width: 1000, font_size: 65, lines: ["x"] }, area2, 65)).toBeNull();
  });
});

// ---------- through the tool ----------

describe("ae_captions fit: layers mode", () => {
  const TEXT = "Our new studio opens in London next week";

  it("re-breaks a caption that measures wider than the safe area, reports it in refit, and QA then passes the safe zone", async () => {
    const { comp, ctx, calls } = scene();
    PX = 0.9;
    const out = (await run(ctx, { comp_id: comp.id, transcript: { text: words(TEXT) }, max_chars_per_line: 42 })) as any;
    // One line of 40 characters at 65 px x 0.9 is 2340 px wide: the plan fits 42 characters, the font does not.
    expect(out.refit).toHaveLength(1);
    expect(out.refit[0]).toMatchObject({ name: "Caption 001", action: "rebreak", from: [TEXT] });
    expect(out.refit[0].to).toHaveLength(2);
    expect(calls.filter((c) => c === "captionsFit")).toHaveLength(1);
    const layer = comp.layer("Caption 001")!;
    expect(doc(layer).text).toBe(out.refit[0].to.join("\r"));
    expect(widthOf(layer)).toBeLessThanOrEqual(1728);
    expect(out.outside_safe).toEqual([]);
    expect(out.warnings.join(" ")).not.toMatch(/outside the safe area/);
    expect(out.fit).toMatchObject({ passes: 1, receipts_ok: true });
    // The second line moved the first baseline up one leading: the bottom stays on the safe area's bottom.
    const y = (layer.transform("Position").value as number[])[1];
    expect(y).toBeCloseTo(1080 * 0.95 - 65 * 0.25 - 65 * 1.2, 6);
    // QA from the layers: no safe_zone issue.
    const qa = (await captionsioTools.find((t) => t.name === "ae_captions_qa")!.handler(AeCaptionsQaSchema.parse({ from_layers: { comp_id: comp.id }, standard: "netflix_adult" }), ctx)) as any;
    expect(qa.counts.safe_zone).toBeUndefined();
  });

  it("scales the font down when a word is too wide to re-break (default order rebreak then shrink), within the 70% floor", async () => {
    const { comp, ctx } = scene();
    PX = 0.9;
    const out = (await run(ctx, { comp_id: comp.id, transcript: { text: words("Supercalifragilisticexpialidocious") } })) as any;
    expect(out.refit).toEqual([{ name: "Caption 001", action: "shrink", from: 65, to: 56 }]);
    const layer = comp.layer("Caption 001")!;
    expect(doc(layer).fontSize).toBe(56);
    expect(widthOf(layer)).toBeLessThanOrEqual(1728);
    expect(out.outside_safe).toEqual([]);
  });

  it("keeps the warning when even the floor does not fit, and fit 'none' only warns", async () => {
    const { comp, ctx, calls } = scene();
    PX = 1.4;
    const out = (await run(ctx, { comp_id: comp.id, transcript: { text: words("Supercalifragilisticexpialidocious") } })) as any;
    expect(out.refit).toEqual([{ name: "Caption 001", action: "shrink", from: 65, to: 46 }]);
    expect(out.outside_safe).toHaveLength(1);
    expect(out.warnings.join(" ")).toMatch(/smallest size fit allows/);
    expect(out.warnings.join(" ")).toMatch(/even after fit/);

    const s2 = scene();
    const none = (await run(s2.ctx, { comp_id: s2.comp.id, transcript: { text: words("Supercalifragilisticexpialidocious") }, fit: "none" })) as any;
    expect(none.refit).toBeUndefined();
    expect(none.outside_safe).toHaveLength(1);
    expect(s2.calls).not.toContain("captionsFit");
    expect(calls).toContain("captionsFit");
  });

  it("fit 'rebreak' never scales and 'shrink' never re-breaks", async () => {
    PX = 0.9;
    const a = scene();
    const onlyRebreak = (await run(a.ctx, { comp_id: a.comp.id, transcript: { text: words("Supercalifragilisticexpialidocious") }, fit: "rebreak" })) as any;
    expect(onlyRebreak.refit).toEqual([]);
    expect(onlyRebreak.outside_safe).toHaveLength(1);
    const b = scene();
    const onlyShrink = (await run(b.ctx, { comp_id: b.comp.id, transcript: { text: words(TEXT) }, max_chars_per_line: 42, fit: "shrink" })) as any;
    expect(onlyShrink.refit).toHaveLength(1);
    expect(onlyShrink.refit[0].action).toBe("shrink");
    expect(doc(b.comp.layer("Caption 001")!).text).toBe(TEXT);
    expect(onlyShrink.outside_safe).toEqual([]);
  });

  it("leaves captions that already fit alone: no fit write", async () => {
    PX = 0.5;
    const { comp, ctx, calls } = scene();
    const out = (await run(ctx, { comp_id: comp.id, transcript: { text: words("Hello there friends") } })) as any;
    expect(out.refit ?? []).toEqual([]);
    expect(calls).not.toContain("captionsFit");
    expect(out.outside_safe).toEqual([]);
  });

  it("a 9:16 comp: fit keeps the caption inside the narrower reels margin", async () => {
    PX = 0.5;
    const { comp, ctx } = scene(1080, 1920);
    const out = (await run(ctx, { comp_id: comp.id, transcript: { text: words("Our new studio opens in London") }, max_chars_per_line: 30 })) as any;
    expect(out.refit.length).toBeGreaterThan(0);
    const layer = comp.layer("Caption 001")!;
    const w = widthOf(layer);
    // reels_9_16: 11% left, 18% right; centred text must clear the wider one.
    expect(w).toBeLessThanOrEqual(1080 - 2 * 1080 * 0.18 + 0.5);
    expect(out.outside_safe).toEqual([]);
  });
});

describe("ae_captions fit: single mode", () => {
  it("re-breaks and shrinks the keys that are too wide and puts the hold keys back", async () => {
    PX = 0.9;
    const { comp, ctx } = scene();
    const at = (list: string[], t0: number) => list.map((t, i) => ({ text: t, start: t0 + i * 0.4, end: t0 + i * 0.4 + 0.3, type: "word" }));
    const text = JSON.stringify({
      words: [
        ...at("Our new studio opens in London next week".split(" "), 0.5),
        // Two lines already, and too wide for two lines at the measured size: only a smaller font fits it.
        ...at("Our new studio opens in London next week and then more words follow".split(" "), 8),
        ...at(["Supercalifragilisticexpialidocious"], 16),
      ],
    });
    const out = (await run(ctx, { comp_id: comp.id, mode: "single", transcript: { text }, max_chars_per_line: 42, pause_break: 1.2 })) as any;
    const actions = out.refit.map((r: any) => r.action);
    expect(actions).toContain("rebreak");
    expect(actions).toContain("shrink");
    expect(out.outside_safe).toEqual([]);
    const layer = comp.layer("Caption")!;
    const prop = (layer.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty;
    const widths = prop.keys.filter((k) => (k.value as TextDocument).text !== "").map((k) => {
      const d = k.value as TextDocument;
      const widest = Math.max(...String(d.text).split("\r").map((l) => l.length));
      return widest * d.fontSize * PX;
    });
    for (const w of widths) expect(w).toBeLessThanOrEqual(1728 + 0.5);
  });
});

describe("ae_captions fit: not for words and template modes", () => {
  it("leaves words mode alone (the layers are already placed word by word)", async () => {
    PX = 0.9;
    const { comp, ctx, calls } = scene();
    const out = (await run(ctx, { comp_id: comp.id, mode: "words", transcript: { text: words("Our new studio opens in London next week") }, max_chars_per_line: 42 })) as any;
    expect(calls).not.toContain("captionsFit");
    expect(out.refit).toBeUndefined();
  });
});

// A reference so the unused import stays meaningful if the helpers move.
export type _Comp = FakeComp;

// ---------- template mode ----------

describe("ae_captions fit: template mode", () => {
  const CAP = "It went out on the 12th of March,";
  const templateScene = (tplWidth = 1600) => {
    const s = scene(1080, 1920);
    const tpl = s.project.addComp("Lower Third", tplWidth, 400, 6);
    tpl.frameRate = 25;
    tpl.controllers = ["Text"];
    tpl.textControllers.add("Text");
    const text = tpl.layers.addText("It went out on the 12th");
    text.name = "Caption";
    const src = text.property("ADBE Text Properties") as FakeGroup;
    (src.property("ADBE Text Document") as FakeProperty).setValue(Object.assign(new TextDocument("It went out on the 12th"), { fontSize: 65 }));
    return { ...s, tpl, text };
  };
  const essential = (l: FakeLayer) => ((l.property("ADBE Layer Overrides") as FakeGroup).props[0] as FakeProperty).value as TextDocument;

  it("re-breaks a caption wider than the template comp, measured in a temporary layer that is gone again", async () => {
    PX = 0.9;
    const { comp, tpl, ctx, calls } = templateScene();
    const before = tpl.stack.length;
    // 34 characters at 65 px x 0.9 = 1989 px: wider than the 1600 px template.
    const out = (await run(ctx, { comp_id: comp.id, mode: "template", template: { comp_id: tpl.id, fields: { Text: "text" } }, transcript: { text: words(CAP) }, max_chars_per_line: 40 })) as any;
    expect(calls).toContain("captionsTemplateMeasure");
    expect(tpl.stack.length).toBe(before);
    expect(out.refit).toHaveLength(1);
    expect(out.refit[0]).toMatchObject({ name: "Caption 001", action: "rebreak", from: [CAP] });
    expect(out.refit[0].to).toHaveLength(2);
    expect(out.template_overflow).toBeUndefined();
    expect(out.template_fit).toEqual({ method: "measured", template_width: 1600 });
    expect(essential(comp.layer("Caption 001")!).text).toBe(out.refit[0].to.join("\r"));
    for (const l of out.refit[0].to as string[]) expect(l.length * 65 * 0.9).toBeLessThanOrEqual(1600);
  });

  it("reports template_overflow when no break makes it fit, and leaves a caption that fits alone", async () => {
    PX = 0.9;
    const { comp, tpl, ctx } = templateScene(1600);
    const out = (await run(ctx, { comp_id: comp.id, mode: "template", template: { comp_id: tpl.id, fields: { Text: "text" } }, transcript: { text: words("Supercalifragilisticexpialidocious") } })) as any;
    expect(out.refit).toBeUndefined();
    expect(out.template_overflow).toEqual([{ name: "Caption 001", width: 1989, template_width: 1600 }]);
    expect(out.warnings.join(" ")).toMatch(/wider than the template comp/);
    const fine = templateScene(2400);
    const ok = (await run(fine.ctx, { comp_id: fine.comp.id, mode: "template", template: { comp_id: fine.tpl.id, fields: { Text: "text" } }, transcript: { text: words(CAP) }, max_chars_per_line: 40 })) as any;
    expect(ok.refit).toBeUndefined();
    expect(ok.template_overflow).toBeUndefined();
  });

  it("estimates from the sample text when no temporary layer can be made, and says so", async () => {
    PX = 0.9;
    const { comp, tpl, ctx } = templateScene();
    const real = tpl.layers.addText;
    tpl.layers.addText = () => {
      throw new Error("locked");
    };
    const out = (await run(ctx, { comp_id: comp.id, mode: "template", template: { comp_id: tpl.id, fields: { Text: "text" } }, transcript: { text: words(CAP) }, max_chars_per_line: 40 })) as any;
    tpl.layers.addText = real;
    expect(out.template_fit).toEqual({ method: "estimated", template_width: 1600 });
    expect(out.warnings.join(" ")).toMatch(/estimated the widths/);
    expect(out.refit).toHaveLength(1);
  });

  it("fit 'none' measures nothing; line fields cap the lines", async () => {
    PX = 0.9;
    const { comp, tpl, ctx, calls } = templateScene();
    await run(ctx, { comp_id: comp.id, mode: "template", fit: "none", template: { comp_id: tpl.id, fields: { Text: "text" } }, transcript: { text: words(CAP) }, max_chars_per_line: 40 });
    expect(calls).not.toContain("captionsTemplateMeasure");
    expect(templateMaxLines({ A: "line1" }, 2)).toBe(1);
    expect(templateMaxLines({ A: "line1", B: "line2", C: "line3" }, 2)).toBe(2);
    expect(templateMaxLines({ T: "text" }, 3)).toBe(3);
  });
});

describe("fit uses the host's criterion for outside_safe", () => {
  it("allows descenders below the safe bottom by the same share, and names why a caption is outside", () => {
    expect(DESCENDER_SHARE).toBe(0.3);
    const area = { comp_width: 1920, left: 96, right: 96, width: 1728, justification: "center" as const };
    // 1693 of 1728 px is not too wide, so a flag on it can only be position (the live case was a comma below the safe bottom).
    expect(isTooWide({ index: 2, name: "c", width: 1693, font_size: 65, lines: ["x"] }, area)).toBe(false);
    expect(outsideReason({ width: 1693 }, area)).toBe("position");
    expect(outsideReason({ width: 1800 }, area)).toBe("too_wide");
  });
});
