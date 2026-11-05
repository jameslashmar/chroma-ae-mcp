import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import { AeFontsSchema, checkpointRefusal, fontMatches, inventoryTools, replaceMismatches, type UsedFont } from "../src/tools/ext/inventory.js";
import { AeGetCompSchema, AeGetProjectSchema, readTools } from "../src/tools/read.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string) => unknown) {
  const scripts: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-inv-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      scripts.push(script);
      return { ok: true, result: answer(script.slice("__chromaAe.".length, script.indexOf("("))), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, scripts };
}

describe("inventory tools", () => {
  it("are registered", () => {
    for (const name of ["ae_comp_tree", "ae_fonts"]) expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
  });

  it("ae_fonts can list only the missing fonts", async () => {
    const { ctx } = fakeAe(() => ({ fonts: [{ font: "A", missing: false }, { font: "B", missing: true }, { font: "C", missing: null }], missing: ["B"] }));
    const out = await inventoryTools.find((t) => t.name === "ae_fonts")!.handler({ missing_only: true }, ctx);
    expect(out.fonts.map((f: { font: string }) => f.font)).toEqual(["B"]);
  });

  it("ae_comp_tree passes the comp and depth through", async () => {
    const { ctx, scripts } = fakeAe(() => ({ comp: { id: 5 } }));
    await inventoryTools.find((t) => t.name === "ae_comp_tree")!.handler({ comp_id: 5, depth: 3 }, ctx);
    expect(scripts[0]).toContain('compTree({"comp_id":5,"depth":3})');
  });
});

describe("paged reads", () => {
  it("ae_get_project walks every level when filtering, unless a depth is given", async () => {
    const { ctx, scripts } = fakeAe(() => ({ items: [] }));
    const tool = readTools.find((t) => t.name === "ae_get_project")!;
    await tool.handler(AeGetProjectSchema.parse({ type: "footage", sort: "name", limit: 50 }), ctx);
    expect(scripts[0]).toContain('"depth":20');
    expect(scripts[0]).toContain('"type":"footage"');
    expect(scripts[0]).toContain('"sort":"name"');
    await tool.handler(AeGetProjectSchema.parse({}), ctx);
    expect(scripts[1]).toContain('getProject({"depth":3})');
  });

  it("ae_get_comp passes paging and the name filter", async () => {
    const { ctx, scripts } = fakeAe(() => ({ layers: [] }));
    await readTools.find((t) => t.name === "ae_get_comp")!.handler(AeGetCompSchema.parse({ comp_id: 1, offset: 500, limit: 100, name_contains: "bg" }), ctx);
    expect(scripts[0]).toContain('"name_contains":"bg","offset":500,"limit":100');
    expect(AeGetCompSchema.safeParse({ comp_id: 1, limit: 501 }).success).toBe(false);
  });
});

// ---------- ae_fonts search / check / replace ----------

describe("ae_fonts schema", () => {
  const parse = (v: unknown) => AeFontsSchema.safeParse(v);
  it("keeps the old call working and adds the actions", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ comp_id: 3, missing_only: true }).success).toBe(true);
    expect(parse({ action: "search", query: "arial", page_size: 100 }).success).toBe(true);
    expect(parse({ action: "search", page_size: 101 }).success).toBe(false);
  });

  it("check needs fonts; replace needs from and to; a real replace needs expect", () => {
    expect(parse({ action: "check" }).success).toBe(false);
    expect(parse({ action: "check", fonts: ["Arial-BoldMT", { family: "Arial", style: "Bold" }], text: "Sgi" }).success).toBe(true);
    expect(parse({ action: "replace", from: "A" }).success).toBe(false);
    expect(parse({ action: "replace", from: "A", to: "B" }).success).toBe(true);
    expect(parse({ action: "replace", from: "A", to: "B", dry_run: false }).success).toBe(false);
    expect(parse({ action: "replace", from: "A", to: "B", dry_run: false, expect: { project_path: "<unsaved>" } }).success).toBe(true);
  });

  it("describes the write and ends with the safety guidance", () => {
    const t = inventoryTools.find((x) => x.name === "ae_fonts")!;
    expect(t.description).toContain("NOT undoable");
    expect(t.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
  });
});

describe("ae_fonts pure logic", () => {
  const used = (postscript: string, family: string, style: string, layer_count = 1, is_substitute = false): UsedFont => ({ postscript, family, style, layer_count, is_substitute });

  it("matches a font by PostScript name or by family and style", () => {
    expect(fontMatches(used("Arial-BoldMT", "Arial", "Bold"), "Arial-BoldMT")).toBe(true);
    expect(fontMatches(used("Arial-BoldMT", "Arial", "Bold"), "ArialMT")).toBe(false);
    expect(fontMatches(used("Arial-BoldMT", "Arial", "Bold"), { family: "arial", style: "bold" })).toBe(true);
  });

  it("refuses a replace unless the checkpoint can restore the project", () => {
    expect(checkpointRefusal({ status: "created", path: "x.aep" })).toBeNull();
    expect(checkpointRefusal({ status: "reused", path: "x.aep" })).toBeNull();
    expect(checkpointRefusal({ status: "skipped", reason: "Auto checkpoints are off" })).toMatch(/Auto checkpoints are off/);
    expect(checkpointRefusal({ status: "created", path: "x.aep", unsaved_changes_not_included: true })).toMatch(/ae_save/);
  });

  it("flags a replace whose read-back still shows the old font or lacks the new one", () => {
    const at = (...ids: number[]) => ids.map((id) => ({ layer_id: id, times: [0] }));
    const withLayers = (u: UsedFont, ids: number[]): UsedFont => ({ ...u, uses: ids.length, layers: at(...ids) });
    const before = { supported: true, fonts: [withLayers(used("Old", "Old", "Regular", 2), [1, 2])] };
    const good = { supported: true, fonts: [withLayers(used("New", "New", "Regular", 2), [1, 2])] };
    expect(replaceMismatches(before, good, "Old", "New")).toEqual([]);
    const stillOld = { supported: true, fonts: [withLayers(used("Old", "Old", "Regular", 1), [2]), withLayers(used("New", "New", "Regular", 1), [1])] };
    expect(replaceMismatches(before, stillOld, "Old", "New").map((x) => x.path)).toEqual(expect.arrayContaining(["from", "to.locations"]));
    expect(replaceMismatches(before, { supported: true, fonts: [] }, "Old", "New").map((x) => x.path)).toContain("to");
    expect(replaceMismatches(before, { supported: true, fonts: [used("New", "New", "Regular", 2, true)] }, "Old", "New").map((x) => x.path)).toContain("to.is_substitute");
    expect(replaceMismatches(before, { supported: false, reason: "needs 24.5", fonts: [] }, "Old", "New")).toHaveLength(1);
  });
});

// A fake font list: what app.fonts gives a host under node:vm.
interface FakeFontSpec {
  ps: string;
  family: string;
  style: string;
  lacks?: string;
  substitute?: boolean;
  variable?: boolean;
  adobe?: boolean;
  scripts?: number[];
}

function makeFont(s: FakeFontSpec) {
  return {
    postScriptName: s.ps,
    familyName: s.family,
    styleName: s.style,
    fullName: `${s.family} ${s.style}`,
    nativeFamilyName: s.family,
    nativeStyleName: s.style,
    nativeFullName: `${s.family} ${s.style}`,
    isFromAdobeFonts: s.adobe === true,
    isSubstitute: s.substitute === true,
    hasDesignAxes: s.variable === true,
    designAxesData: s.variable ? [{ axisTag: "wght", axisName: "Weight", minValue: 100, maxValue: 900, defaultValue: 400 }] : [],
    designVector: s.variable ? [400] : undefined,
    postScriptNameForDesignVector: (v: number[]) => `${s.ps}-w${v[0]}`,
    location: `C:/Fonts/${s.ps}.ttf`,
    fontID: s.ps.length,
    writingScripts: s.scripts ?? [1],
    otherFontsWithSameDict: [],
    // Like a real font: no cmap glyph for line breaks and other control characters.
    hasGlyphsFor: (str: string) => !/[\r\n\t\u0003\u2028\u2029]/.test(str) && (!s.lacks || ![...str].some((c) => s.lacks!.includes(c))),
  };
}

const DEFAULT_FONT_LIST: FakeFontSpec[][] = [
  [
    { ps: "ArialMT", family: "Arial", style: "Regular" },
    { ps: "Arial-BoldMT", family: "Arial", style: "Bold" },
  ],
  [{ ps: "Inter-Variable", family: "Inter", style: "Variable", variable: true, adobe: true, scripts: [1, 2] }],
  [{ ps: "Impact", family: "Impact", style: "Regular", lacks: "\u015f\u011f\u0131\u0130" }],
];

function fontScene(list: FakeFontSpec[][] = DEFAULT_FONT_LIST) {
  const families = list.map((fam) => fam.map(makeFont));
  const flat = families.flat();
  const byPs = (ps: string) => flat.filter((f) => f.postScriptName === ps);
  const fonts = {
    allFonts: families,
    getFontsByPostScriptName: (ps: string) => byPs(ps),
    getFontsByFamilyNameAndStyleName: (fa: string, st: string) => flat.filter((f) => f.familyName === fa && f.styleName === st),
    fontsDuplicateByPostScriptName: [],
    fontsWithDefaultDesignAxes: flat.filter((f) => f.hasDesignAxes),
    missingOrSubstitutedFonts: [{ postScriptName: "Brand-Bold" }],
    getCTScriptForString: (s: string) => [{ chars: s, ctScript: 1 }],
    getDefaultFontForCTScript: () => flat[0],
  };
  const project = new FakeProject();
  const loaded = loadHost(project, ["inventory.jsx"], { fonts });
  loaded.G.CTScript = { CT_ROMAN_SCRIPT: 1, CT_CYRILLIC_SCRIPT: 2, CT_GREEK_SCRIPT: 3 };
  return { project, fonts, flat, ...loaded };
}

describe("inventory.jsx: font search and check", () => {
  it("searches installed fonts, paged, by name, family, style, script and kind", () => {
    const { A } = fontScene();
    const all = A.inventorySearchFonts({});
    expect(all).toMatchObject({ available: true, total_matches: 4, scan_truncated: false, has_more: false });
    expect(all.fonts[0]).toMatchObject({ postscript: "ArialMT", family: "Arial", style: "Regular", is_from_adobe_fonts: false, location: "C:/Fonts/ArialMT.ttf" });
    expect(A.inventorySearchFonts({ query: "arial bold" }).fonts.map((f: any) => f.postscript)).toEqual(["Arial-BoldMT"]);
    expect(A.inventorySearchFonts({ family: "ari", style: "reg" }).fonts.map((f: any) => f.postscript)).toEqual(["ArialMT"]);
    const variable = A.inventorySearchFonts({ variable_only: true });
    expect(variable.fonts.map((f: any) => f.postscript)).toEqual(["Inter-Variable"]);
    expect(variable.fonts[0].axes).toEqual([{ tag: "wght", name: "Weight", min: 100, max: 900, default: 400 }]);
    expect(A.inventorySearchFonts({ adobe_only: true }).total_matches).toBe(1);
    expect(A.inventorySearchFonts({ writing_script: "cyrillic" }).fonts.map((f: any) => f.postscript)).toEqual(["Inter-Variable"]);
    const page2 = A.inventorySearchFonts({ page: 2, page_size: 3 });
    expect(page2).toMatchObject({ page: 2, total_matches: 4, has_more: false });
    expect(page2.fonts).toHaveLength(1);
    expect(A.inventorySearchFonts({ page: 1, page_size: 3 }).has_more).toBe(true);
  });

  it("finds writing scripts by the names the schema documents, not only the exact enum keys", () => {
    const { A, G } = fontScene([
      [{ ps: "Sc", family: "Sc", style: "Regular", scripts: [4] }],
      [{ ps: "Tr", family: "Tr", style: "Regular", scripts: [5] }],
      [{ ps: "Ee", family: "Ee", style: "Regular", scripts: [6] }],
    ]);
    G.CTScript = { CT_ROMAN_SCRIPT: 1, CT_SIMPLIFIEDCHINESE_SCRIPT: 4, CT_TRADITIONALCHINESE_SCRIPT: 5, CT_EASTEUROPEANROMAN_SCRIPT: 6 };
    const ps = (q: string) => A.inventorySearchFonts({ writing_script: q }).fonts.map((f: any) => f.postscript);
    expect(ps("chinese_simplified")).toEqual(["Sc"]);
    expect(ps("simplified_chinese")).toEqual(["Sc"]);
    expect(ps("Chinese Traditional")).toEqual(["Tr"]);
    expect(ps("east-european-roman")).toEqual(["Ee"]);
    expect(ps("CT_SIMPLIFIEDCHINESE_SCRIPT")).toEqual(["Sc"]);
    expect(() => A.inventorySearchFonts({ writing_script: "klingon" })).toThrow(/CTScript/);
  });

  it("resolves documented script names even when the CTScript object cannot be enumerated", () => {
    const { A, G } = fontScene([
      [{ ps: "Sc", family: "Sc", style: "Regular", scripts: [4] }],
      [{ ps: "Tr", family: "Tr", style: "Regular", scripts: [5] }],
      [{ ps: "Ee", family: "Ee", style: "Regular", scripts: [6] }],
    ]);
    const hidden: Record<string, number> = {};
    for (const [k, v] of Object.entries({ CT_ROMAN_SCRIPT: 1, CT_SIMPLIFIEDCHINESE_SCRIPT: 4, CT_TRADITIONALCHINESE_SCRIPT: 5, CT_EASTEUROPEANROMAN_SCRIPT: 6 })) {
      Object.defineProperty(hidden, k, { value: v, enumerable: false });
    }
    G.CTScript = hidden;
    const ps = (q: string) => A.inventorySearchFonts({ writing_script: q }).fonts.map((f: any) => f.postscript);
    expect(ps("chinese_simplified")).toEqual(["Sc"]);
    expect(ps("simplified_chinese")).toEqual(["Sc"]);
    expect(ps("Chinese Traditional")).toEqual(["Tr"]);
    expect(ps("east-european-roman")).toEqual(["Ee"]);
    expect(() => A.inventorySearchFonts({ writing_script: "klingon" })).toThrow(/CTScript/);
  });

  it("refuses an unknown script, reports a missing font API, and changes nothing", () => {
    const { A, undo } = fontScene();
    expect(() => A.inventorySearchFonts({ writing_script: "klingon" })).toThrow(/CTScript/);
    expect(undo.begun).toBe(0);
    const none = loadHost(new FakeProject(), ["inventory.jsx"], { fonts: undefined });
    expect(none.A.inventorySearchFonts({})).toMatchObject({ available: false, fonts: [] });
    expect(none.A.inventoryCheckFonts({ fonts: ["ArialMT"] })).toMatchObject({ available: false });
  });

  it("scans in a bounded way", () => {
    const big: FakeFontSpec[][] = [Array.from({ length: 9000 }, (_, i) => ({ ps: `F${i}`, family: "Fam", style: `S${i}` }))];
    const { A } = fontScene(big);
    const r = A.inventorySearchFonts({ page_size: 10 });
    expect(r.scan_truncated).toBe(true);
    expect(r.scanned).toBeLessThanOrEqual(8000);
    expect(r.note).toMatch(/partly scanned/);
  });

  it("checks existence, glyphs for the real text, variable axes and a fallback for a missing font", () => {
    const { A } = fontScene();
    const r = A.inventoryCheckFonts({ fonts: ["Impact", { family: "Arial", style: "Bold" }, "Inter-Variable", "Brand-Bold"], text: "\u015e\u011f\u0131 \u0130stanbul" });
    const [impact, arial, inter, brand] = r.checked;
    expect(impact).toMatchObject({ exists: true, is_substitute: false });
    expect(impact.glyphs.supported).toBe(false);
    expect(impact.glyphs.missing).toEqual(expect.arrayContaining(["\u011f", "\u0131", "\u0130"]));
    expect(impact.glyphs.suggested_default).toEqual([{ ct_script: "1", postscript: "ArialMT" }]);
    expect(arial).toMatchObject({ exists: true, requested: "Arial Bold" });
    expect(arial.glyphs.supported).toBe(true);
    expect(inter.variable.axes[0].tag).toBe("wght");
    expect(inter.variable).toMatchObject({ design_vector: [400], instance_postscript: "Inter-Variable-w400", default_instance_postscript: "Inter-Variable" });
    expect(brand).toMatchObject({ exists: false, is_substitute: null });
    expect(brand.reason).toMatch(/No installed font/);
    expect(brand.fallback.suggested_default).toHaveLength(1);
    expect(r.project_missing_or_substituted).toEqual(["Brand-Bold"]);
  });

  it("checks without text and bounds the font list", () => {
    const { A } = fontScene();
    const r = A.inventoryCheckFonts({ fonts: ["ArialMT"] });
    expect(r.checked[0].glyphs).toBeUndefined();
    expect(r.text_checked).toBe(false);
    expect(() => A.inventoryCheckFonts({ fonts: [] })).toThrow(/1\.\.50/);
    expect(() => A.inventoryCheckFonts({ fonts: [{ family: "Arial" }] })).toThrow(/PostScript name/);
  });

  it("says when the AE cannot check glyphs (before 25.1)", () => {
    const { A, flat } = fontScene();
    for (const f of flat) delete (f as any).hasGlyphsFor;
    const r = A.inventoryCheckFonts({ fonts: ["ArialMT"], text: "abc" });
    expect(r.checked[0].glyphs.supported).toBeNull();
    expect(r.checked[0].glyphs.reason).toMatch(/25\.1/);
  });
});

// ---------- the replace: host ----------

function replaceScene(opts: { toSubstitute?: boolean; noTo?: boolean; replaceReturns?: boolean; dirty?: boolean; manyFonts?: number } = {}) {
  const sc = fontScene([
    [{ ps: "Impact", family: "Impact", style: "Regular", lacks: "\u015f\u011f\u0131\u0130" }],
    [{ ps: "Brand-Bold", family: "Brand", style: "Bold", substitute: true }],
    [{ ps: "Roboto-Bold", family: "Roboto", style: "Bold", substitute: opts.toSubstitute === true }],
  ]);
  const [impact, brand, roboto] = sc.flat;
  const comp = { id: 7, name: "Main" };
  const layers: Record<number, any> = {};
  const makeLayer = (id: number, name: string, text: string) => {
    layers[id] = {
      id,
      name,
      index: id,
      containingComp: comp,
      property: () => ({ property: () => ({ numKeys: 0, value: { text } }) }),
    };
  };
  makeLayer(11, "Title", "\u015fehir");
  makeLayer(12, "Sub", "plain");
  makeLayer(13, "Other", "other");
  (sc.project as any).layerByID = (id: number) => layers[id] ?? null;
  const usedFonts: any[] = [
    { fontObject: brand, usedAt: [{ layerID: 11, layerTimeD: 0 }, { layerID: 12, layerTimeD: 1.5 }] },
    { fontObject: impact, usedAt: [{ layerID: 13, layerTimeD: 0 }] },
  ];
  if (opts.manyFonts) {
    // Filler fonts ahead of the wanted ones: a filtered read must still find them.
    const filler = Array.from({ length: opts.manyFonts }, (_, i) => ({ fontObject: { postScriptName: `Filler-${i}`, familyName: `Filler${i}`, styleName: "Regular", isSubstitute: false }, usedAt: [] }));
    usedFonts.unshift(...filler);
  }
  if (opts.dirty) (sc.project as any).dirty = true;
  (sc.project as any).usedFonts = usedFonts;
  const calls: unknown[][] = [];
  (sc.project as any).replaceFont = (a: unknown, b: unknown, c: unknown) => {
    calls.push([a, b, c]);
    if (opts.replaceReturns !== undefined) return opts.replaceReturns;
    const i = usedFonts.findIndex((u) => u.fontObject === a);
    const moved = usedFonts.splice(i, 1)[0];
    usedFonts.push({ fontObject: b, usedAt: moved.usedAt });
    return true;
  };
  if (opts.noTo) (sc.fonts as any).getFontsByPostScriptName = (ps: string) => (ps === "Roboto-Bold" ? [] : sc.flat.filter((f) => f.postScriptName === ps));
  return { ...sc, calls, usedFonts, impact, brand, roboto };
}

describe("inventory.jsx: used fonts and the replace", () => {
  it("reads Project.usedFonts and resolves the layers", () => {
    const { A } = replaceScene();
    const r = A.inventoryUsedFonts({});
    expect(r.supported).toBe(true);
    expect(r.fonts.map((f: any) => f.postscript)).toEqual(["Brand-Bold", "Impact"]);
    expect(r.fonts[0]).toMatchObject({ is_substitute: true, layer_count: 2, uses: 2 });
    expect(r.fonts[0].layers[1].times).toEqual([1.5]);
    expect(r.fonts[0].layers[0]).toMatchObject({ layer_id: 11, layer: "Title", comp_id: 7, comp: "Main", times: [0], resolved: true });
    expect(A.inventoryUsedFonts({ fonts: [{ family: "Impact", style: "Regular" }] }).fonts).toHaveLength(1);
    const none = loadHost(new FakeProject(), ["inventory.jsx"], { fonts: {} });
    expect(none.A.inventoryUsedFonts({})).toMatchObject({ supported: false });
  });

  it("counts distinct layers apart from layer-and-time uses, and accepts the alternative time names", () => {
    const { A, usedFonts, brand } = replaceScene();
    usedFonts[0] = { fontObject: brand, usedAt: [{ layerID: 11, layerTimeD: 0 }, { layerID: 11, layerTimeD: 2 }, { layerID: 12, layerTimes: [3] }] };
    const f = A.inventoryUsedFonts({ fonts: ["Brand-Bold"] }).fonts[0];
    expect(f).toMatchObject({ layer_count: 2, uses: 3 });
    expect(f.layers.map((l: any) => l.times)).toEqual([[0], [2], [3]]);
    expect(A.inventoryReplacePlan({ from: "Brand-Bold", to: "Impact" })).toMatchObject({ affected_layers: 2, uses: 3 });
  });

  it("finds the wanted fonts even when the project uses more than 500", () => {
    const { A } = replaceScene({ manyFonts: 600 });
    const r = A.inventoryUsedFonts({ fonts: ["Brand-Bold"] });
    expect(r.fonts.map((f: any) => f.postscript)).toEqual(["Brand-Bold"]);
    expect(r.truncated).toBe(false);
    expect(A.inventoryReplacePlan({ from: "Brand-Bold", to: "Impact" })).toMatchObject({ from_used: true });
    expect(A.inventoryUsedFonts({}).truncated).toBe(true);
  });

  it("the dry run lists the layers and warns about glyphs the new font lacks", () => {
    const { A, undo, calls } = replaceScene();
    const plan = A.inventoryReplacePlan({ from: "Brand-Bold", to: "Impact" });
    expect(plan).toMatchObject({ ok: true, from_used: true, affected_layers: 2 });
    expect(plan.layers.map((l: any) => l.layer)).toEqual(["Title", "Sub"]);
    expect(plan.glyphs.checked_layers).toBe(2);
    expect(plan.glyphs.warnings).toHaveLength(1);
    expect(plan.glyphs.warnings[0]).toMatchObject({ layer: "Title", missing: ["\u015f"] });
    expect(undo.begun).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("the dry run reports an unused from font, a missing new font and a substituted new font", () => {
    const unused = replaceScene().A.inventoryReplacePlan({ from: "Roboto-Bold", to: "Impact" });
    expect(unused).toMatchObject({ ok: true, from_used: false, affected_layers: 0 });
    expect(unused.reason).toMatch(/nothing to replace/);
    const gone = replaceScene({ noTo: true }).A.inventoryReplacePlan({ from: "Brand-Bold", to: "Roboto-Bold" });
    expect(gone).toMatchObject({ ok: false, error: "font_not_found" });
    const sub = replaceScene({ toSubstitute: true }).A.inventoryReplacePlan({ from: "Brand-Bold", to: "Roboto-Bold" });
    expect(sub).toMatchObject({ ok: false, error: "font_substituted" });
  });

  it("replaces inside one undo group with the used font object, and reports it as not undoable", () => {
    const { A, undo, calls, impact, brand, usedFonts } = replaceScene();
    const out = A.inventoryReplaceFont({ from: "Brand-Bold", to: "Impact", no_font_locking: true, expect: GUARD });
    expect(out).toMatchObject({ replaced: true, from: "Brand-Bold", to: "Impact", no_font_locking: true, layers_affected: 2, undoable: false });
    expect(calls).toEqual([[brand, impact, true]]);
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(usedFonts.map((u) => u.fontObject.postScriptName)).toEqual(["Impact", "Impact"]);
  });

  it("reports no_op when replaceFont returns false", () => {
    const { A } = replaceScene({ replaceReturns: false });
    const out = A.inventoryReplaceFont({ from: "Brand-Bold", to: "Impact", expect: GUARD });
    expect(out).toMatchObject({ no_op: true, replaced: false, layers_changed: false });
    expect(out.warning).toMatch(/no layer changed/);
  });

  it("refuses before the call when the project went dirty after the checkpoint", () => {
    const { A, calls, undo } = replaceScene({ dirty: true });
    expect(() => A.inventoryReplaceFont({ from: "Brand-Bold", to: "Impact", expect: GUARD })).toThrow(/unsaved changes/);
    expect(calls).toHaveLength(0);
    expect(undo.begun).toBe(0);
  });

  it("changes nothing, and opens no undo group, when the font is unused or the fonts are the same", () => {
    const { A, undo, calls } = replaceScene();
    expect(A.inventoryReplaceFont({ from: "Roboto-Bold", to: "Impact", expect: GUARD })).toMatchObject({ no_op: true, replaced: false });
    expect(A.inventoryReplaceFont({ from: "Impact", to: "Impact", expect: GUARD })).toMatchObject({ no_op: true });
    expect(calls).toHaveLength(0);
    expect(undo.begun).toBe(0);
  });

  it("reads keyed source text at comp time: layer time is shifted by the layer's start time and stretch", () => {
    const { A, project } = replaceScene();
    const comp = { id: 7, name: "Main" };
    // Layer 11 starts at 5 s: layer time 0 is comp time 5. Its text is "plain" before comp time 5 and "\u015fehir" from then on.
    const reads: number[] = [];
    const keyed = {
      id: 11, name: "Title", index: 11, containingComp: comp, startTime: 5, stretch: 100,
      property: () => ({ property: () => ({ numKeys: 2, value: { text: "plain" }, valueAtTime: (t: number) => { reads.push(t); return { text: t >= 5 ? "\u015fehir" : "plain" }; } }) }),
    };
    (project as any).layerByID = (id: number) => (id === 11 ? keyed : { id, name: "x", index: id, containingComp: comp, property: () => ({ property: () => ({ numKeys: 0, value: { text: "plain" } }) }) });
    const plan = A.inventoryReplacePlan({ from: "Brand-Bold", to: "Impact" });
    expect(reads[0]).toBe(5);
    expect(plan.glyphs.warnings).toHaveLength(1);
    expect(plan.glyphs.warnings[0]).toMatchObject({ layer: "Title", missing: ["\u015f"] });
    // A stretch of 200% doubles layer time into comp time.
    // Layer time 2 s at 200% stretch from a start of 1 s is comp time 1 + 2 * 2 = 5; without the stretch term it would read 3.
    (project as any).usedFonts[0].usedAt[0].layerTimeD = 2;
    keyed.startTime = 1;
    keyed.stretch = 200;
    reads.length = 0;
    A.inventoryReplacePlan({ from: "Brand-Bold", to: "Impact" });
    expect(reads[0]).toBe(5);
  });

  it("does not let line breaks in the text trip the glyph check", () => {
    const { A, project } = replaceScene();
    const comp = { id: 7, name: "Main" };
    const layer = (id: number, text: string) => ({ id, name: "L" + id, index: id, containingComp: comp, property: () => ({ property: () => ({ numKeys: 0, value: { text } }) }) });
    (project as any).layerByID = (id: number) => layer(id, id === 11 ? "ab\rcd\nef" : "plain");
    const plan = A.inventoryReplacePlan({ from: "Brand-Bold", to: "Impact" });
    expect(plan.glyphs.warnings).toEqual([]);
    const { A: A2 } = fontScene();
    const r = A2.inventoryCheckFonts({ fonts: ["ArialMT"], text: "Sehir\r\nok\tx" });
    expect(r.checked[0].glyphs.supported).toBe(true);
    expect(r.checked[0].glyphs.missing).toEqual([]);
  });

  it("refuses before the call: guard, missing replaceFont, missing or substituted new font", () => {
    const sc = replaceScene();
    expect(() => sc.A.inventoryReplaceFont({ from: "Brand-Bold", to: "Impact", expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(() => sc.A.inventoryReplaceFont({ from: "Brand-Bold", to: "Impact" })).toThrow(/expect\.project_path/);
    expect(() => sc.A.inventoryReplaceFont({ from: "Brand-Bold", to: "Nope", expect: GUARD })).toThrow(/not installed/);
    const sub = replaceScene({ toSubstitute: true });
    expect(() => sub.A.inventoryReplaceFont({ from: "Brand-Bold", to: "Roboto-Bold", expect: GUARD })).toThrow(/substituted/);
    delete (sc.project as any).replaceFont;
    expect(() => sc.A.inventoryReplaceFont({ from: "Brand-Bold", to: "Impact", expect: GUARD })).toThrow(/24\.5/);
    expect(sc.undo.begun + sub.undo.begun).toBe(0);
  });
});

// ---------- the replace: tool flow ----------

describe("ae_fonts tool flow", () => {
  const tool = inventoryTools.find((t) => t.name === "ae_fonts")!;

  /** A bridge whose AE answers by host function; checkGuard reports the given project. */
  function bridge(projectPath: string, answers: Record<string, unknown[]>, dirty = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fonts-q-"));
    tmpDirs.push(dir);
    const calls: Array<{ fn: string; script: string }> = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push({ fn, script });
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: projectPath, dirty, comp_is_valid: true }, durationMs: 1 };
        const next = answers[fn]?.shift();
        if (next === undefined) throw new Error(`Unexpected script: ${script}`);
        return { ok: true, result: next, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    return { ctx, calls, dir };
  }

  function savedProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fonts-p-"));
    tmpDirs.push(dir);
    const aep = path.join(dir, "Demo.aep");
    fs.writeFileSync(aep, "aep");
    return aep;
  }

  const PLAN = { ok: true, from_used: true, affected_layers: 2, layers: [], glyphs: { checked_layers: 2, unchecked_layers: 0, warnings: [] } };
  const usedBefore = { supported: true, fonts: [{ postscript: "Brand-Bold", family: "Brand", style: "Bold", is_substitute: true, layer_count: 2 }] };
  const usedAfter = { supported: true, fonts: [{ postscript: "Impact", family: "Impact", style: "Regular", is_substitute: false, layer_count: 2 }] };

  it("search and check pass their arguments through and summarise problems", async () => {
    const { ctx, calls } = bridge("<unsaved>", {
      inventorySearchFonts: [{ available: true, fonts: [], total_matches: 0 }],
      inventoryCheckFonts: [{ available: true, checked: [{ exists: true, is_substitute: false, glyphs: { supported: false } }, { exists: true, is_substitute: false }] }],
    });
    await tool.handler(AeFontsSchema.parse({ action: "search", query: "arial", variable_only: true, page: 2 }), ctx);
    expect(calls[0].script).toContain('inventorySearchFonts({"query":"arial","variable_only":true,"page":2})');
    const out = await tool.handler(AeFontsSchema.parse({ action: "check", fonts: ["Impact", { family: "A", style: "B" }], text: "\u015e\u011f" }), ctx);
    expect(calls[1].script).toContain('"fonts":["Impact",{"family":"A","style":"B"}]');
    expect(calls[1].script).toContain('"text":"\\u015e\\u011f"');
    expect(out.problems).toBe(1);
  });

  it("a dry run (the default) reads the plan and writes nothing", async () => {
    const { ctx, calls } = bridge("<unsaved>", { inventoryReplacePlan: [PLAN] });
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact" }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["inventoryReplacePlan"]);
    expect(out).toMatchObject({ dry_run: true, applied: false, affected_layers: 2 });
    expect(out.next).toMatch(/dry_run: false/);
    expect(out.notes.join(" ")).toMatch(/not undoable/);
  });

  it("returns a failed plan as it is, and a no-op for an unused font, without a write", async () => {
    const { ctx, calls } = bridge("<unsaved>", { inventoryReplacePlan: [{ ok: false, error: "font_not_found", reason: "x" }, { ...PLAN, from_used: false, affected_layers: 0 }] });
    const args = { action: "replace", from: "A", to: "B", dry_run: false, expect: { project_path: "<unsaved>" } };
    const bad = await tool.handler(AeFontsSchema.parse(args), ctx);
    expect(bad).toMatchObject({ ok: false, error: "font_not_found", applied: false });
    const none = await tool.handler(AeFontsSchema.parse(args), ctx);
    expect(none).toMatchObject({ applied: false, no_op: true });
    expect(calls.map((c) => c.fn)).toEqual(["inventoryReplacePlan", "inventoryReplacePlan"]);
  });

  it("refuses to replace without a checkpoint (an unsaved project) and never writes", async () => {
    const { ctx, calls } = bridge("<unsaved>", { inventoryReplacePlan: [PLAN] });
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact", dry_run: false, expect: { project_path: "<unsaved>" } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "checkpoint_required", applied: false });
    expect(out.message).toMatch(/cannot be undone/);
    expect(calls.map((c) => c.fn)).toEqual(["inventoryReplacePlan", "checkGuard"]);
  });

  it("refuses when the project has unsaved changes the checkpoint would not hold", async () => {
    const aep = savedProject();
    const { ctx, calls } = bridge(aep, { inventoryReplacePlan: [PLAN] }, true);
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact", dry_run: false, expect: { project_path: aep } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "checkpoint_required" });
    expect(out.message).toMatch(/unsaved changes/);
    expect(out.checkpoint.unsaved_changes_not_included).toBe(true);
    expect(calls.map((c) => c.fn)).not.toContain("inventoryReplaceFont");
  });

  it("checkpoints, writes, and reads the used fonts back in separate calls", async () => {
    const aep = savedProject();
    const { ctx, calls } = bridge(aep, {
      inventoryReplacePlan: [PLAN],
      inventoryUsedFonts: [usedBefore, usedAfter],
      inventoryReplaceFont: [{ replaced: true, from: "Brand-Bold", to: "Impact", layers_affected: 2, undoable: false }],
    });
    const out = await tool.handler(
      AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact", no_font_locking: true, dry_run: false, expect: { project_path: aep } }),
      ctx
    );
    expect(calls.map((c) => c.fn)).toEqual(["inventoryReplacePlan", "checkGuard", "checkGuard", "inventoryUsedFonts", "inventoryReplaceFont", "inventoryUsedFonts"]);
    expect(calls[4].script).toContain('"no_font_locking":true');
    expect(calls[4].script).toContain('"expect"');
    expect(out).toMatchObject({ applied: true, replaced: true, undoable: false, dry_run: false });
    expect(["created", "reused"]).toContain(out.checkpoint.status);
    expect(out.checkpoint.unsaved_changes_not_included).toBeUndefined();
    expect(fs.existsSync(out.checkpoint.path)).toBe(true);
    expect(out.receipt.matches).toBe(true);
  });

  it("verifies by location: a layer that already used the new font does not trip the check", () => {
    const loc = (id: number, t: number) => ({ layer_id: id, times: [t] });
    const before = { supported: true, fonts: [
      { postscript: "Brand-Bold", family: "Brand", style: "Bold", layer_count: 2, uses: 2, layers: [loc(11, 0), loc(12, 0)] },
      { postscript: "Impact", family: "Impact", style: "Regular", layer_count: 1, uses: 1, layers: [loc(11, 0)] },
    ] };
    const after = { supported: true, fonts: [{ postscript: "Impact", family: "Impact", style: "Regular", is_substitute: false, layer_count: 2, uses: 2, layers: [loc(11, 0), loc(12, 0)] }] };
    expect(replaceMismatches(before, after, "Brand-Bold", "Impact")).toEqual([]);
    const lost = { ...after, fonts: [{ ...after.fonts[0], layers: [loc(11, 0)], uses: 1, layer_count: 1 }] };
    expect(replaceMismatches(before, lost, "Brand-Bold", "Impact").map((m) => m.path)).toContain("to.locations");
    const capped = { ...after, fonts: [{ ...after.fonts[0], layers: [loc(11, 0)], uses: 150, layer_count: 150 }] };
    expect(replaceMismatches(before, capped, "Brand-Bold", "Impact")).toEqual([]);
  });

  it("does not pass a replace whose replaceFont returned false: the old font is still used", async () => {
    const aep = savedProject();
    const { ctx } = bridge(aep, {
      inventoryReplacePlan: [PLAN],
      inventoryUsedFonts: [usedBefore, usedBefore],
      inventoryReplaceFont: [{ no_op: true, replaced: false, layers_changed: false, warning: "After Effects reported that no layer changed (replaceFont returned false).", undoable: false }],
    });
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact", dry_run: false, expect: { project_path: aep } }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toContain("from");
  });

  it("does not flag the host's pre-write no-op (same font) as a failed replace", async () => {
    const aep = savedProject();
    const { ctx } = bridge(aep, {
      inventoryReplacePlan: [PLAN],
      inventoryUsedFonts: [usedBefore, usedBefore],
      inventoryReplaceFont: [{ no_op: true, replaced: false, reason: "The old and new fonts are the same.", undoable: false }],
    });
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact", dry_run: false, expect: { project_path: aep } }), ctx);
    expect(out.receipt.matches).toBe(true);
  });

  it("the note names real ways back, not a tool that does not exist", async () => {
    const { ctx } = bridge("<unsaved>", { inventoryReplacePlan: [PLAN] });
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact" }), ctx);
    const notes = out.notes.join(" ");
    expect(notes).not.toContain("ae_undo");
    expect(notes).toContain("ae_checkpoint_revert");
  });

  it("puts a failed verification into the receipt instead of throwing", async () => {
    const aep = savedProject();
    const { ctx } = bridge(aep, {
      inventoryReplacePlan: [PLAN],
      inventoryUsedFonts: [usedBefore, usedBefore],
      inventoryReplaceFont: [{ replaced: true, from: "Brand-Bold", to: "Impact", layers_affected: 2, undoable: false }],
    });
    const out = await tool.handler(AeFontsSchema.parse({ action: "replace", from: "Brand-Bold", to: "Impact", dry_run: false, expect: { project_path: aep } }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toContain("from");
  });
});
