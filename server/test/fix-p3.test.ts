/**
 * Regression tests for the review fixes in masks, layout and the house style:
 * checks run before the undo group, exact font matching, truncation flags,
 * a hand-edited brief, and the MOGRT folder created only after the guard.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { fontMatches } from "../src/style.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeHouseStyleCheckSchema, cleanBriefStyle, layoutTools, styleFindings } from "../src/tools/ext/layout.js";
import { AeMaskSchema, AeTextAnimatorSchema, animatorMismatches, maskMismatches, masksTools } from "../src/tools/ext/masks.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string, args: any) => unknown, projectPath = "<unsaved>") {
  const calls: string[] = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-fixp3-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: projectPath, comp_id: 1, comp_is_valid: true, dirty: false }, durationMs: 1 };
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")) || "{}");
      return { ok: true, result: answer(fn, args), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const tool = (name: string) => [...masksTools, ...layoutTools].find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  return { project, comp };
}

describe("fontMatches is exact", () => {
  it("does not match another weight or family that shares a prefix", () => {
    expect(fontMatches({ font: "Gotham-Light", family: "Gotham" }, ["Gotham Bold"])).toBe(false);
    expect(fontMatches({ font: "ArialMT", family: "Arial" }, ["Arial Black"])).toBe(false);
    expect(fontMatches({ font: "HelveticaNeue-Medium", family: "Helvetica Neue" }, ["Helvetica"])).toBe(false);
    expect(fontMatches({ font: "Helvetica", family: "Helvetica" }, ["Helvetica Neue"])).toBe(false);
    expect(fontMatches({ font: "ArialNarrow", family: "Arial Narrow" }, ["Arial"])).toBe(false);
  });

  it("matches the family, the PostScript name, or the family with its style", () => {
    expect(fontMatches({ font: "Gotham-Light", family: "Gotham" }, ["Gotham"])).toBe(true);
    expect(fontMatches({ font: "Gotham-Bold", family: "Gotham" }, ["Gotham Bold"])).toBe(true);
    expect(fontMatches({ font: "Arial-BoldMT", family: "Arial", style: "Bold" }, ["Arial Bold"])).toBe(true);
    expect(fontMatches({ font: "Arial-ItalicMT", family: "Arial", style: "Italic" }, ["Arial Bold"])).toBe(false);
  });
});

describe("ae_align checks everything before it moves anything", () => {
  function twoLayers() {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "layout.jsx"]);
    for (const [n, x] of [["Still", 100], ["Moving", 300]] as Array<[string, number]>) {
      A.createLayer({ comp_id: comp.id, type: "solid", name: n, width: 40, height: 20, expect: GUARD });
      comp.layer(n)!.transform("ADBE Position").setValue([x, 100, 0]);
    }
    return { comp, A };
  }

  it("leaves the static layer alone when a later one is animated and shift_keys is missing", () => {
    const { comp, A } = twoLayers();
    comp.layer("Moving")!.transform("ADBE Position").setValuesAtTimes([0, 1], [[300, 100, 0], [400, 100, 0]]);
    expect(() => A.alignLayers({ comp_id: comp.id, layers: [{ name: "Still" }, { name: "Moving" }], align: "top", time: 0, expect: GUARD })).toThrow(/Moving.*animated/);
    expect(comp.layer("Still")!.transform("ADBE Position").value).toEqual([100, 100, 0]);
    // With shift_keys both go.
    A.alignLayers({ comp_id: comp.id, layers: [{ name: "Still" }, { name: "Moving" }], align: "top", time: 0, shift_keys: true, expect: GUARD });
    expect((comp.layer("Still")!.transform("ADBE Position").value as number[])[1]).toBe(0);
  });

  it("refuses the same layer listed twice instead of moving it twice", () => {
    const { comp, A } = twoLayers();
    expect(() => A.alignLayers({ comp_id: comp.id, layers: [{ name: "Still" }, { index: comp.layer("Still")!.index }], align: "right", to: "comp", expect: GUARD })).toThrow(/listed twice/);
    expect(comp.layer("Still")!.transform("ADBE Position").value).toEqual([100, 100, 0]);
  });
});

describe("ae_mask checks before the undo group", () => {
  function plate() {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "masks.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    A.maskEdit({
      comp_id: comp.id,
      layer: { name: "Plate" },
      add: [
        { name: "One", shape: "rect", box: [0, 0, 10, 10] },
        { name: "Two", shape: "rect", box: [0, 0, 20, 20] },
        { name: "Three", shape: "rect", box: [0, 0, 30, 30] },
      ],
      expect: GUARD,
    });
    return { comp, A };
  }
  const names = (A: any, compId: number) => A.maskList({ comp_id: compId, layer: { name: "Plate" } }).masks.map((m: any) => m.name);

  it("removes a mask selected twice only once", () => {
    const { comp, A } = plate();
    const r = A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, remove: [{ index: 2 }, { name: "Two" }], expect: GUARD });
    expect(r.removed).toHaveLength(1);
    expect(names(A, comp.id)).toEqual(["One", "Three"]);
  });

  it("changes nothing when a later set targets a keyframed property", () => {
    const { comp, A } = plate();
    const layer = comp.layer("Plate")!;
    const parade = layer.property("ADBE Mask Parade") as any;
    parade.property(2).property("ADBE Mask Opacity").setValueAtTime(0, 10);
    expect(() =>
      A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, set: [{ mask: { index: 1 }, opacity: 50 }, { mask: { index: 2 }, opacity: 20 }], expect: GUARD })
    ).toThrow(/keyframes on opacity.*Nothing was changed/);
    expect(A.maskList({ comp_id: comp.id, layer: { name: "Plate" } }).masks[0].opacity).toBe(100);
  });

  it("refuses a mask that is both changed and removed", () => {
    const { comp, A } = plate();
    expect(() => A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, set: [{ mask: { index: 3 }, opacity: 5 }], remove: [{ name: "Three" }], expect: GUARD })).toThrow(/both changed and removed/);
    expect(names(A, comp.id)).toEqual(["One", "Two", "Three"]);
  });

  it("refuses an unknown mode before writing", () => {
    const { comp, A } = plate();
    expect(() => A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, set: [{ mask: { index: 1 }, opacity: 5 }, { mask: { index: 2 }, mode: "wobble" }], expect: GUARD })).toThrow(/Unknown mask mode/);
    expect(A.maskList({ comp_id: comp.id, layer: { name: "Plate" } }).masks[0].opacity).toBe(100);
  });
});

describe("ae_mask schema and receipt", () => {
  const base = { comp_id: 1, layer: { index: 1 }, expect: expectArg };

  it("rejects box, vertices or closed on a change without a shape", () => {
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, box: [0, 0, 500, 500] }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, closed: false }] }).success).toBe(false);
    expect(AeMaskSchema.safeParse({ ...base, set: [{ mask: { index: 1 }, shape: "rect", box: [0, 0, 500, 500] }] }).success).toBe(true);
  });

  it("checks a path's points and closed state, not only its vertex count", () => {
    const args = AeMaskSchema.parse({
      ...base,
      add: [{ shape: "path", vertices: [[0, 0], [100, 0], [100, 50], [0, 50]], closed: true }],
    });
    const read = (box: number[], closed: boolean) => ({ count: 1, masks: [{ index: 1, name: "Mask 1", mode: "add", inverted: false, feather: [0, 0], opacity: 100, expansion: 0, vertices: 4, closed, box }] });
    const written = { added: [{ index: 1 }], removed: [], changed: [] };
    expect(maskMismatches(args, { count: 0, masks: [] }, read([0, 0, 100, 50], true), written)).toEqual([]);
    expect(maskMismatches(args, { count: 0, masks: [] }, read([0, 0, 90, 50], true), written).map((x) => x.path)).toContain("masks[1].box[2]");
    expect(maskMismatches(args, { count: 0, masks: [] }, read([0, 0, 100, 50], false), written).map((x) => x.path)).toEqual(["masks[1].closed"]);
  });
});

describe("ae_text_animator receipt", () => {
  const state = (sel: object) => ({ count: 1, animators: [{ index: 1, name: "A", properties: [{ matchName: "ADBE Text Opacity", value: 0 }], selectors: [sel] }] });

  it("does not compare the static end the reveal keys over", () => {
    const args = AeTextAnimatorSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      properties: { opacity: 0 },
      selector: { end: 100 },
      reveal: { property: "end", from: 0, to: 100, start_time: 0, duration: 1 },
      expect: expectArg,
    });
    expect(animatorMismatches(args, { count: 0, animators: [] }, state({ start: 0, end: 0, end_keys: 2 }), { index: 1 })).toEqual([]);
  });

  it("still compares start when the reveal keys end", () => {
    const args = AeTextAnimatorSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      properties: { opacity: 0 },
      selector: { start: 20, end: 100 },
      reveal: { property: "end", from: 0, to: 100, start_time: 0, duration: 1 },
      expect: expectArg,
    });
    const m = animatorMismatches(args, { count: 0, animators: [] }, state({ start: 0, end: 0, end_keys: 2 }), { index: 1 });
    expect(m.map((x) => x.path)).toEqual(["selector.start"]);
  });
});

describe("ae_purge_unused and the style scan report truncation", () => {
  it("flags a scan cut at 500 and counts what was found", () => {
    const { project } = scene();
    for (let i = 0; i < 503; i++) project.addFootage(`f${i}.png`, 10, 10);
    const { A } = loadHost(project, ["layout.jsx"]);
    const u = A.unusedItems({});
    expect(u.items).toHaveLength(500);
    expect(u).toMatchObject({ total_unused: 503, truncated: true });
    expect(A.unusedItems({ kinds: ["solid"] })).toMatchObject({ total_unused: 0, truncated: false });
  });

  it("passes the flag through the dry run", async () => {
    const unused = { items: [{ id: 5, name: "a.png", kind: "footage", file: null }], folders: [], numItems: 600, total_unused: 700, truncated: true };
    const { ctx } = fakeAe(() => unused);
    const out = await tool("ae_purge_unused").handler({}, ctx);
    expect(out).toMatchObject({ dry_run: true, count: 1, truncated: true, total_unused: 700 });
  });

  it("flags a style scan cut at 500 layers", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "layout.jsx"]);
    for (let i = 0; i < 502; i++) A.createLayer({ comp_id: comp.id, type: "solid", name: `S${i}`, expect: GUARD });
    expect(A.styleScan({ comp_id: comp.id })).toMatchObject({ truncated: true });
    expect(A.styleScan({ comp_id: comp.id }).layers).toHaveLength(500);
  });
});

describe("min_font_size uses the size on screen", () => {
  it("scans the layer's scale and the text style", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "layout.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "text", text: "Hi", expect: GUARD });
    comp.layer(1)!.transform("ADBE Scale").setValue([50, 50, 100]);
    const l = A.styleScan({ comp_id: comp.id }).layers[0];
    expect(l).toMatchObject({ font_size: 72, font_style: "Regular", scale_factor: 0.5, screen_font_size: 36 });
  });

  it("flags by screen size, not document size", () => {
    const layers = [
      { index: 1, id: 1, name: "Shrunk", kind: "text", enabled: true, font: "Gotham", family: "Gotham", font_size: 80, screen_font_size: 32, scale_factor: 0.4, colours: [] },
      { index: 2, id: 2, name: "Grown", kind: "text", enabled: true, font: "Gotham", family: "Gotham", font_size: 20, screen_font_size: 60, scale_factor: 3, colours: [] },
    ] as any[];
    const f = styleFindings(layers, { brand_colors: [], fonts: [], tolerance: 12, neutrals_ok: true, min_font_size: 40 });
    expect(f.map((x) => [x.kind, x.layer.name])).toEqual([["small_text", "Shrunk"]]);
    expect(f[0].message).toMatch(/32 px on screen/);
  });
});

describe("ae_export_mogrt makes its folder only after the guard", () => {
  it("leaves no new folders when the guard refuses", async () => {
    const root = tempDir("chroma-mogrt-guard-");
    const out = path.join(root, "new", "deep", "T.mogrt");
    const { ctx, calls } = fakeAe(() => ({}), "C:/jobs/other.aep");
    await expect(tool("ae_export_mogrt").handler({ comp_id: 1, path: out, expect: expectArg }, ctx)).rejects.toThrow();
    expect(calls).not.toContain("exportMogrt");
    expect(fs.existsSync(path.join(root, "new"))).toBe(false);
  });

  it("leaves no new folders when AE reports no export", async () => {
    const root = tempDir("chroma-mogrt-none-");
    const out = path.join(root, "new", "T.mogrt");
    const { ctx } = fakeAe((fn) => ({ exported: false, controllers: 1, template_name: "T" }));
    const res = await tool("ae_export_mogrt").handler({ comp_id: 1, path: out, expect: expectArg }, ctx);
    expect(res).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(root, "new"))).toBe(false);
  });
});

describe("ae_house_style_check", () => {
  const textLayer = (i: number) => ({ index: i, id: i, name: `T${i}`, kind: "text", enabled: true, font: "Gotham-Bold", family: "Gotham", font_style: "Bold", font_size: 40, colours: [{ where: "text fill", role: "fill", rgb: [0.9, 0.1, 0.1] }] });
  const boundsAnswer = { layer: { index: 1, id: 1, name: "T" }, kind: "text", checkable: true, reason: null, samples: [{ time: 0, visible: true, rect: [100, 100, 200, 150] }] };

  it("skips bad brief entries instead of crashing, and says so", async () => {
    const dir = tempDir("chroma-style-bad-");
    const aep = path.join(dir, "Job.aep");
    fs.writeFileSync(path.join(dir, "Job.brief.json"), JSON.stringify({ brand_colors: ["red", "#fff", "#ff0000"], fonts: "Gotham" }));
    const { ctx } = fakeAe((fn) => {
      if (fn === "status") return { project_path: aep };
      if (fn === "styleScan") return { width: 640, height: 360, time: 0, layers: [textLayer(1)] };
      return boundsAnswer;
    }, aep);
    const out = await tool("ae_house_style_check").handler(AeHouseStyleCheckSchema.parse({ comp_id: 1 }), ctx);
    expect(out.ok).toBe(true);
    expect(out.used).toMatchObject({ brand_colors: ["#ff0000"], fonts: ["Gotham"] });
    expect(out.ignored_brief_entries).toEqual(['brand colour "red"', 'brand colour "#fff"']);
    expect(out.findings.map((x: { kind: string }) => x.kind)).not.toContain("off_brand_font");
  });

  it("cleans odd brief values", () => {
    expect(cleanBriefStyle({ brand_colors: ["#FF0000", 5, "blue"], fonts: ["Gotham", "", null] })).toEqual({
      colors: ["#FF0000"],
      fonts: ["Gotham"],
      ignored: ['brand colour 5', 'brand colour "blue"', 'font ""', "font null"],
    });
    expect(cleanBriefStyle(null)).toEqual({ colors: [], fonts: [], ignored: [] });
  });

  it("checks title safe on at most 50 text layers and says when it stopped", async () => {
    const layers = Array.from({ length: 60 }, (_, i) => textLayer(i + 1));
    let boundsCalls = 0;
    const { ctx } = fakeAe((fn) => {
      if (fn === "status") return { project_path: "<unsaved>" };
      if (fn === "styleScan") return { width: 640, height: 360, time: 0, truncated: true, layers };
      boundsCalls++;
      return boundsAnswer;
    });
    const out = await tool("ae_house_style_check").handler(AeHouseStyleCheckSchema.parse({ comp_id: 1 }), ctx);
    expect(boundsCalls).toBe(50);
    expect(out).toMatchObject({ truncated: true, safe_area_truncated: true, safe_area_checked: 50 });
  });

  it("reports a layer whose bounds could not be read as unchecked", async () => {
    const { ctx } = fakeAe((fn) => {
      if (fn === "status") return { project_path: "<unsaved>" };
      if (fn === "styleScan") return { width: 640, height: 360, time: 0, layers: [textLayer(1)] };
      throw new Error("No layer with id 1");
    });
    const out = await tool("ae_house_style_check").handler(AeHouseStyleCheckSchema.parse({ comp_id: 1 }), ctx);
    expect(out.ok).toBe(true);
    expect(out.safe_area_unchecked).toHaveLength(1);
  });

  it("stops at once when a bounds read times out instead of reading the other layers", async () => {
    const calls: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tempDir("chroma-fixp3-q-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push(fn);
        if (fn === "status") return { ok: true, result: { project_path: "<unsaved>" }, durationMs: 1 };
        if (fn === "styleScan") return { ok: true, result: { width: 640, height: 360, time: 0, layers: [textLayer(1), textLayer(2), textLayer(3)] }, durationMs: 1 };
        return new Promise(() => {});
      },
      queue,
      quarantine,
      defaultTimeoutMs: 20,
    } as any);
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    await expect(tool("ae_house_style_check").handler(AeHouseStyleCheckSchema.parse({ comp_id: 1 }), ctx)).rejects.toMatchObject({ kind: "timeout" });
    expect(calls.filter((c) => c === "layerBoundsAt")).toHaveLength(1);
  });
});
