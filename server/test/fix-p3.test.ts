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

// ---------- wave 5 receipts ----------

describe("ae_mask receipt (wave 5)", () => {
  const read = (over: object, extra: object = {}) => ({
    count: 1,
    masks: [{ index: 1, name: "Mask 1", mode: "add", inverted: false, feather: [0, 0], opacity: 100, expansion: 0, vertices: 4, closed: true, box: [0, 0, 100, 50], ...over, ...extra }],
  });
  const args = AeMaskSchema.parse({
    comp_id: 1,
    layer: { index: 1 },
    add: [{ shape: "rect", box: [0, 0, 100, 50], feather_falloff: "linear", motion_blur: "on", color: [0, 1, 0], locked: true, roto_bezier: true }],
    expect: expectArg,
  });
  const written = { added: [{ index: 1 }], removed: [], changed: [] };

  it("passes when the attributes read back as written, within colour rounding", () => {
    const ok = read({ feather_falloff: "linear", motion_blur: "on", color: [0.003, 0.998, 0], locked: true, roto_bezier: true });
    expect(maskMismatches(args, { count: 0, masks: [] }, ok, written)).toEqual([]);
  });

  it("flags each attribute that differs", () => {
    const bad = read({ feather_falloff: "smooth", motion_blur: "off", color: [1, 0, 0], locked: false, roto_bezier: false });
    expect(maskMismatches(args, { count: 0, masks: [] }, bad, written).map((x) => x.path)).toEqual([
      "masks[1].feather_falloff",
      "masks[1].motion_blur",
      "masks[1].locked",
      "masks[1].roto_bezier",
      "masks[1].color",
    ]);
  });

  it("does not flag an attribute this After Effects cannot read (null)", () => {
    const none = read({ feather_falloff: null, motion_blur: null, color: null, locked: null, roto_bezier: null });
    expect(maskMismatches(args, { count: 0, masks: [] }, none, written)).toEqual([]);
  });

  it("counts copies and finds a changed mask by its final index", () => {
    const set = AeMaskSchema.parse({ comp_id: 1, layer: { index: 1 }, set: [{ mask: { name: "B" }, opacity: 30 }], duplicate: [{ mask: { name: "B" } }], expect: expectArg });
    const mk = (names: string[], opacity: number[]) => ({
      count: names.length,
      masks: names.map((n, i) => ({ index: i + 1, name: n, mode: "add", inverted: false, feather: [0, 0], opacity: opacity[i], expansion: 0, vertices: 4, box: [0, 0, 1, 1] })),
    });
    // The copy has the same name as its source: only the final index tells which one was changed.
    const w = { changed: [{ index: 2, name: "B", final_index: 3 }], removed: [], added: [], duplicated: [{ index: 2, name: "B" }], moved: [] };
    expect(maskMismatches(set, mk(["A", "B"], [100, 100]), mk(["A", "B", "B"], [100, 100, 30]), w)).toEqual([]);
    expect(maskMismatches(set, mk(["A", "B"], [100, 100]), mk(["A", "B", "B"], [100, 30, 100]), w).map((x) => x.path)).toEqual(["masks[B].opacity"]);
    expect(maskMismatches(set, mk(["A", "B"], [100, 100]), mk(["A", "B"], [100, 30]), w).map((x) => x.path)).toContain("count");
  });

  it("checks the order against the plan and the names read before the write, not the host's in-script names", () => {
    const mv = AeMaskSchema.parse({ comp_id: 1, layer: { index: 1 }, move_to: [{ mask: { name: "C" }, index: 1 }], duplicate: [{ mask: { name: "B" } }], expect: expectArg });
    const mk = (names: string[]) => ({
      count: names.length,
      masks: names.map((n, i) => ({ index: i + 1, name: n, mode: "add", inverted: false, feather: [0, 0], opacity: 100, expansion: 0, vertices: 4, box: [0, 0, 1, 1] })),
    });
    const before = mk(["A", "B", "C"]);
    // C moved to the top, B copied below B: the copy's own name is After Effects' choice.
    const plan = [{ original: 3 }, { original: 1 }, { original: 2 }, { copy_of: 2 }];
    const w = { changed: [], removed: [], added: [], duplicated: [{ index: 3, name: "B 2" }], moved: [{ from: 4, to: 1, name: "C", name_at_target: "STALE" }], order: ["stale"], plan_order: plan };
    expect(maskMismatches(mv, before, mk(["C", "A", "B", "Mask 4"]), w)).toEqual([]);
    expect(maskMismatches(mv, before, mk(["A", "C", "B", "B 2"]), w).map((x) => x.path)).toEqual(["order"]);
  });

  it("does not flag masks past the end of a capped read", () => {
    const add = AeMaskSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [{ shape: "rect", box: [0, 0, 5, 5] }], expect: expectArg });
    const capped = { count: 201, truncated: true, masks: [{ index: 1, name: "M", mode: "add", inverted: false, feather: [0, 0], opacity: 100, expansion: 0, vertices: 4, box: [0, 0, 5, 5] }] };
    expect(maskMismatches(add, { count: 200, masks: [] }, capped, { added: [{ index: 201 }], removed: [], changed: [] })).toEqual([]);
  });
});

describe("ae_text_animator receipt (wave 5)", () => {
  const sel = (over: object = {}) => ({ index: 1, type: "range", start: 0, end: 100, start_keys: 0, end_keys: 0, offset_keys: 0, children: [] as object[], ...over });
  const state = (selectors: object[], properties: object[] = [{ name: "Opacity", matchName: "ADBE Text Opacity", value: 0 }], more: object | null = null) => ({
    count: 1,
    animators: [{ index: 1, name: "A", properties, selectors }],
    more_options: more,
  });
  const info = (fields: Record<string, [string, string]>, extra: object = {}) => ({
    index: 1,
    type: "range",
    fields: Object.fromEntries(Object.entries(fields).map(([k, [match_name, name]]) => [k, { match_name, name }])),
    ...extra,
  });
  const parse = (extra: object) => AeTextAnimatorSchema.parse({ comp_id: 1, layer: { index: 1 }, properties: { opacity: 0 }, expect: expectArg, ...extra });
  const none = { count: 0, animators: [] };

  it("compares range selector fields through the read-back children, enums as menu numbers and switches as 1 or 0", () => {
    const args = parse({ selector: { units: "index", mode: "subtract", based_on: "words", randomize: true, amount: 50 } });
    const fields = {
      units: ["ADBE Text Range Units", "Units"],
      mode: ["ADBE Text Selector Mode", "Mode"],
      based_on: ["ADBE Text Range Type2", "Based On"],
      randomize: ["ADBE Text Randomize Order", "Randomize Order"],
      amount: ["ADBE Text Selector Max Amount", "Amount"],
    } as Record<string, [string, string]>;
    const child = (f: string, value: unknown) => ({ name: fields[f][1], matchName: fields[f][0], value });
    const good = [child("units", 2), child("mode", 2), child("based_on", 3), child("randomize", 1), child("amount", 50)];
    expect(animatorMismatches(args, none, state([sel({ children: good })]), { index: 1, selectors: [info(fields)] })).toEqual([]);
    const bad = [child("units", 1), child("mode", 2), child("based_on", 3), child("randomize", 0), child("amount", 50)];
    expect(animatorMismatches(args, none, state([sel({ children: bad })]), { index: 1, selectors: [info(fields)] }).map((x) => x.path)).toEqual(["selector.units", "selector.randomize"]);
  });

  it("checks a wiggly selector found at its own index, and a field missing from the read-back", () => {
    const args = parse({ selector: { type: "range", start: 10 }, more_selectors: [{ type: "wiggly", max_amount: 80, lock_dimensions: true }] });
    const fields = { start: ["ADBE Text Percent Start", "Start"] } as Record<string, [string, string]>;
    const wig = { max_amount: ["ADBE Text Wiggly Max Amount", "Max Amount"], lock_dimensions: ["ADBE Text Wiggly Lock Dim", "Lock Dimensions"] } as Record<string, [string, string]>;
    const after = state([
      sel({ children: [{ name: "Start", matchName: "ADBE Text Percent Start", value: 10 }] }),
      sel({ index: 2, type: "wiggly", children: [{ name: "Max Amount", matchName: "ADBE Text Wiggly Max Amount", value: 70 }] }),
    ]);
    const m = animatorMismatches(args, none, after, { index: 1, selectors: [info(fields), info(wig, { index: 2, type: "wiggly" })] });
    expect(m.map((x) => x.path)).toEqual(["selectors[1].max_amount", "selectors[1].lock_dimensions"]);
    expect(m[1].message).toMatch(/not in the read-back/);
  });

  it("flags an expression that differs or reports an error", () => {
    const args = parse({ selector: { type: "expression", expression: "textIndex*2" } });
    const f = { expression: ["ADBE Text Expressible Amount", "Amount"] } as Record<string, [string, string]>;
    const mk = (expression: string, expression_error = "") => state([sel({ type: "expression", children: [{ name: "Amount", matchName: "ADBE Text Expressible Amount", value: 0, expression, expression_error }] })]);
    const w = { index: 1, selectors: [info(f, { type: "expression" })] };
    expect(animatorMismatches(args, none, mk("textIndex*2"), w)).toEqual([]);
    expect(animatorMismatches(args, none, mk("textIndex*3"), w).map((x) => x.path)).toEqual(["selector.expression"]);
    expect(animatorMismatches(args, none, mk("textIndex*2", "Bad expression"), w).map((x) => x.path)).toEqual(["selector.expression_error"]);
  });

  it("uses the match name the host resolved for an animator property", () => {
    const args = parse({ properties: { character_range: 2 } });
    const after = state([sel()], [{ name: "Character Range", matchName: "ADBE Text Character Range Type", value: 2 }]);
    expect(animatorMismatches(args, none, after, { index: 1, property_matches: { character_range: { match_name: "ADBE Text Character Range Type", name: "Character Range" } } })).toEqual([]);
    expect(animatorMismatches(args, none, after, { index: 1 }).map((x) => x.path)).toEqual(["animator.character_range"]);
  });

  it("adds alpha for a stroke colour like a fill colour", () => {
    const args = parse({ properties: { stroke_color: [1, 0, 0] } });
    const after = state([sel()], [{ name: "Stroke Color", matchName: "ADBE Text Stroke Color", value: [1, 0, 0, 1] }]);
    expect(animatorMismatches(args, none, after, { index: 1 })).toEqual([]);
  });

  it("checks variable axes by the index and name the host reported", () => {
    const args = parse({ variable_axes: [{ tag: "wght", value: 700 }] });
    const props = (value: number, matchName = "ADBE Text Variable Axis wght") => [{ name: "Opacity", matchName: "ADBE Text Opacity", value: 0 }, { name: "Axis wght", matchName, value }];
    const w = { index: 1, variable_axes: [{ tag: "wght", value: 700, index: 2, name: "Axis wght", match_name: "ADBE Text Variable Axis wght" }] };
    expect(animatorMismatches(args, none, state([sel()], props(700)), w)).toEqual([]);
    expect(animatorMismatches(args, none, state([sel()], props(400)), w).map((x) => x.path)).toEqual(["animator.axis.wght"]);
    const gone = state([sel()], [{ name: "Opacity", matchName: "ADBE Text Opacity", value: 0 }]);
    expect(animatorMismatches(args, none, gone, w).map((x) => x.path)).toEqual(["animator.axis.wght"]);
  });

  it("checks More Options, mapping the anchor grouping name to its menu number", () => {
    const args = parse({ grouping: { anchor_point_grouping: "word", fill_and_stroke: 2 } });
    expect(animatorMismatches(args, none, state([sel()], undefined, { anchor_point_grouping: 2, fill_and_stroke: 2 }), { index: 1 })).toEqual([]);
    expect(animatorMismatches(args, none, state([sel()], undefined, { anchor_point_grouping: 1, fill_and_stroke: 2 }), { index: 1 }).map((x) => x.path)).toEqual(["grouping.anchor_point_grouping"]);
    expect(animatorMismatches(args, none, state([sel()], undefined, null), { index: 1 }).map((x) => x.path)).toEqual(["grouping.anchor_point_grouping", "grouping.fill_and_stroke"]);
  });

  it("checks the reveal's keys on the first range selector when a wiggly selector comes first", () => {
    const args = parse({ selector: { type: "wiggly" }, more_selectors: [{ type: "range" }], reveal: { from: 0, to: 100, start_time: 0, duration: 1 } });
    const w = { index: 1, selectors: [info({}, { index: 1, type: "wiggly" }), info({}, { index: 2 })] };
    const ok = state([sel({ type: "wiggly" }), sel({ index: 2, start_keys: 2 })]);
    const bad = state([sel({ type: "wiggly" }), sel({ index: 2, start_keys: 1 })]);
    expect(animatorMismatches(args, none, ok, w)).toEqual([]);
    expect(animatorMismatches(args, none, bad, w).map((x) => x.path)).toEqual(["selector.reveal"]);
  });

  it("lines up specs with the written selectors when only more_selectors is given", () => {
    const args = parse({ more_selectors: [{ type: "wiggly", max_amount: 80 }] });
    const wig = { max_amount: ["ADBE Text Wiggly Max Amount", "Max Amount"] } as Record<string, [string, string]>;
    const after = state([sel({ type: "wiggly", children: [{ name: "Max Amount", matchName: "ADBE Text Wiggly Max Amount", value: 80 }] })]);
    expect(animatorMismatches(args, none, after, { index: 1, selectors: [info(wig, { type: "wiggly" })] })).toEqual([]);
  });

  it("with more_selectors [wiggly, range] and a reveal, checks the keys on the range selector", () => {
    const args = parse({ more_selectors: [{ type: "wiggly" }, { type: "range", start: 0 }], reveal: { from: 0, to: 100, start_time: 0, duration: 1 } });
    const w = { index: 1, selectors: [info({}, { index: 1, type: "wiggly" }), info({}, { index: 2 })] };
    expect(animatorMismatches(args, none, state([sel({ type: "wiggly" }), sel({ index: 2, start_keys: 2 })]), w)).toEqual([]);
    expect(animatorMismatches(args, none, state([sel({ type: "wiggly" }), sel({ index: 2, start_keys: 0 })]), w).map((x) => x.path)).toEqual(["selector.reveal"]);
  });
});
