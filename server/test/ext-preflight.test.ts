import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { createAerenderTools } from "../src/tools/ext/aerender.js";
import {
  AePreflightSchema,
  attachSequences,
  buildFindings,
  buildNameChecker,
  clearPreflightSessions,
  compWeight,
  isDefaultName,
  newScanState,
  nestingDepths,
  normaliseOptions,
  preflightRefusal,
  preflightTools,
  runPreflightGate,
  runScan,
  sortFindings,
  templateToRegex,
  titleSafeHit,
  type BoundsResult,
  type CompInfo,
  type Counts,
  type Finding,
  type FootageInfo,
  type HostLayerIssue,
  type LayersPage,
  type ProjectInfo,
} from "../src/tools/ext/preflight.js";
import { renderTools } from "../src/tools/render.js";
import { nodeSeqIo, seqscanDeps } from "../src/seqscan.js";
import { makeSequence, useOldFiles } from "./support/seq-fixtures.js";
import {
  FakeGroup,
  FakeProperty,
  FakeComp,
  FakeLayer,
  FakeFootage,
  FakeProject,
  FileSource,
  PlaceholderSource,
  PropertyValueType,
  SolidSource,
  TextDocument,
  loadHost,
} from "./support/fake-ae.js";
// The guard folds case on Windows only (as AE's own guard in core.jsx does), so the different-case spelling is a Windows test.
const EXPECT_DEMO = process.platform === "win32" ? "c:/projects/demo.aep" : "C:/Projects/Demo.aep";

const tmpDirs: string[] = [];
beforeEach(() => clearPreflightSessions());
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = preflightTools.find((t) => t.name === "ae_preflight")!;

// ---------- a scripted AE for the Node side ----------

type Handlers = Record<string, (args: any) => unknown>;

/** A PanelHost whose AE answers each host function from a handler, recording every call. */
function fakeAe(handlers: Handlers) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-preflight-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.length - 1));
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: h(args), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, dir };
}

const noCounts = (): Counts => ({ layers: 0, effects: 0, expressions: 0, keys: 0, three_d: 0, text: 0, precomp: 0 });

const project = (extra: Partial<ProjectInfo> = {}): ProjectInfo => ({
  aeVersion: "26.2.1",
  project_path: "C:/Projects/Demo.aep",
  saved: true,
  dirty: false,
  numItems: 0,
  bits_per_channel: 8,
  working_space: "sRGB IEC61966-2.1",
  linear_blending: false,
  expression_engine: "javascript-1.0",
  installed_effects: 300,
  effects_check: "available",
  missing_fonts: [],
  fonts_check: "available",
  render_queue: { numItems: 0, rendering: false, items: [], truncated: false },
  ...extra,
});

const comp = (id: number, name: string, extra: Partial<CompInfo> = {}): CompInfo => ({
  id,
  name,
  width: 1920,
  height: 1080,
  fps: 25,
  duration: 10,
  layers: 0,
  renderer: "ADBE Advanced 3d",
  used_n: 0,
  used_in: [],
  ...extra,
});

const footage = (id: number, name: string, extra: Partial<FootageInfo> = {}): FootageInfo => ({
  id,
  name,
  kind: "footage",
  file: `C:/media/${name}`,
  missing: false,
  width: 1920,
  height: 1080,
  used_n: 1,
  used_in: [1],
  proxy: null,
  ...extra,
});

interface CompSpec {
  info: CompInfo;
  layers?: string[];
  issues?: HostLayerIssue[];
  precomps?: number[];
  texts?: Array<{ index: number; id: number; name: string }>;
  counts?: Partial<Counts>;
}

/** A project the host functions answer for, paged the way the real ones page. */
function world(opts: { project?: ProjectInfo; comps: CompSpec[]; footage?: FootageInfo[]; bounds?: (args: any) => BoundsResult }) {
  const proj = opts.project ?? project();
  const items: Array<{ comp?: CompInfo; footage?: FootageInfo }> = [...opts.comps.map((c) => ({ comp: c.info })), ...(opts.footage ?? []).map((f) => ({ footage: f }))];
  const handlers: Handlers = {
    status: () => ({ project_path: proj.project_path }),
    preflightProject: () => proj,
    preflightItems: (a) => {
      const slice = items.slice(a.offset, a.offset + a.limit);
      const end = a.offset + slice.length;
      return {
        offset: a.offset,
        total: items.length,
        next_offset: end < items.length ? end : null,
        comps: slice.filter((x) => x.comp).map((x) => x.comp),
        footage: slice.filter((x) => x.footage).map((x) => x.footage),
        folders: 0,
      };
    },
    preflightLayers: (a): LayersPage => {
      const spec = opts.comps.find((c) => c.info.id === a.comp_id)!;
      const names = spec.layers ?? [];
      const page = names.slice(a.from - 1, a.from - 1 + a.limit);
      const to = a.from - 1 + page.length;
      const first = a.from === 1;
      return {
        comp_id: spec.info.id,
        name: spec.info.name,
        width: spec.info.width,
        height: spec.info.height,
        time: 1,
        renderer: spec.info.renderer,
        num_layers: names.length,
        from: a.from,
        to,
        next_from: to < names.length ? to + 1 : null,
        layers: page.map((n, i) => ({ index: a.from + i, name: n, kind: "solid", enabled: true })),
        counts: { ...noCounts(), layers: page.length, ...(first ? spec.counts : {}) },
        precomp_ids: first ? spec.precomps ?? [] : [],
        texts: first && a.text_candidates ? spec.texts ?? [] : [],
        issues: first ? spec.issues ?? [] : [],
        issues_overflow: 0,
        forced_evals: 0,
        fonts_unchecked: 0,
        effects_check: "available",
      };
    },
    layerBoundsAt: (a) => (opts.bounds ? opts.bounds(a) : { layer: { index: 1, id: a.layer.id, name: "T" }, kind: "text", checkable: true, reason: null, samples: [] }),
  };
  return handlers;
}

const codes = (r: { findings: Finding[] }) => r.findings.map((f) => f.code);
const find = (r: { findings: Finding[] }, code: string) => r.findings.filter((f) => f.code === code);
const PREFLIGHT_HOSTS = new Set(["status", "preflightProject", "preflightItems", "preflightLayers", "layerBoundsAt"]);

// ---------- schemas ----------

describe("ae_preflight schema", () => {
  it("takes no required arguments and defaults to nothing", () => {
    expect(AePreflightSchema.safeParse({}).success).toBe(true);
    expect(AePreflightSchema.safeParse({ scope: "health", top: 5, max_nesting: 3 }).success).toBe(true);
  });

  it("rejects an unknown scope, a bad cursor and out-of-range limits", () => {
    expect(AePreflightSchema.safeParse({ scope: "everything" }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ cursor: "abc" }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ cursor: "pf_0123456789" }).success).toBe(true);
    expect(AePreflightSchema.safeParse({ max_slices: 0 }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ budget_ms: 10 }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ title_safe: 0.9 }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ comp_ids: [] }).success).toBe(false);
  });

  it("naming takes a template or a pattern, never both, and checks they compile", () => {
    expect(AePreflightSchema.safeParse({ naming: { template: "{word}_{ver}" } }).success).toBe(true);
    expect(AePreflightSchema.safeParse({ naming: { pattern: "^[A-Z]" } }).success).toBe(true);
    expect(AePreflightSchema.safeParse({ naming: { template: "{word}", pattern: "x" } }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ naming: { pattern: "(" } }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ naming: { template: "{nope}" } }).success).toBe(false);
  });

  it("project_spec only accepts real bit depths", () => {
    expect(AePreflightSchema.safeParse({ project_spec: { bits_per_channel: 16, linear_blending: true } }).success).toBe(true);
    expect(AePreflightSchema.safeParse({ project_spec: { bits_per_channel: 12 } }).success).toBe(false);
  });

  it("is read-only: it does not take expect", () => {
    const parsed = AePreflightSchema.parse({ scope: "delivery" });
    expect(parsed).not.toHaveProperty("expect");
    expect(tool.description).toContain("Changes nothing in After Effects");
  });
});

describe("render tools' preflight option", () => {
  it("ae_render_queue_add and ae_aerender_start accept preflight", () => {
    const add = renderTools.find((t) => t.name === "ae_render_queue_add")!;
    expect(add.schema.safeParse({ comp_id: 1, output_path: "C:/o/a.mov", preflight: true, expect: { project_path: "<unsaved>" } }).success).toBe(true);
    const start = createAerenderTools().find((t) => t.name === "ae_aerender_start")!;
    expect(start.schema.safeParse({ comp_name: "Main", output_path: "C:/o/a.mov", preflight: true, expect: { project_path: "C:/p.aep" } }).success).toBe(true);
    expect(add.description).toMatch(/preflight: true/);
    expect(start.description).toMatch(/preflight: true/);
  });
});

// ---------- pure logic ----------

describe("naming rules", () => {
  it("knows AE's default names", () => {
    for (const n of ["Comp 1", "Pre-comp 12", "Solid 2", "Shape Layer 3", "Null 4", "Adjustment Layer 1", "Medium Gray-Royal Blue Solid 1", "Camera 1"]) {
      expect(isDefaultName(n), n).toBe(true);
    }
    for (const n of ["Comp", "Main Comp", "Hero_v01", "Solid", "Comp 1 Copy"]) expect(isDefaultName(n), n).toBe(false);
  });

  it("turns a token template into an anchored regex", () => {
    const re = templateToRegex("{word}_{word}_{ver}");
    expect(re.test("ACME_Intro_v03")).toBe(true);
    expect(re.test("ACME_Intro_v")).toBe(false);
    expect(re.test("xACME_Intro_v03!")).toBe(false);
    expect(templateToRegex("{date}-{n}.mov").test("2026-10-30-2.mov")).toBe(true);
    expect(templateToRegex("a.b").test("axb")).toBe(false);
    expect(() => templateToRegex("{bogus}")).toThrow(/Unknown token/);
  });

  it("reports default names, spaces and rule mismatches together", () => {
    const check = buildNameChecker({ template: "{word}_{ver}", forbid_spaces: true });
    expect(check("Comp 1")).toEqual(["default name", "contains spaces", 'does not match template "{word}_{ver}"']);
    expect(check("Intro_v02")).toEqual([]);
    expect(buildNameChecker({ allow_default_names: true })("Comp 1")).toEqual([]);
    expect(buildNameChecker({ pattern: "^[A-Z]" })("intro")).toEqual(["does not match /^[A-Z]/"]);
  });
});

describe("scale helpers", () => {
  it("nesting depth is the longest chain of precomps, cycle-safe", () => {
    const edges = new Map<number, number[]>([
      [1, [2, 3]],
      [2, [4]],
      [3, []],
      [4, []],
    ]);
    const d = nestingDepths(edges);
    expect([d.get(1), d.get(2), d.get(3), d.get(4)]).toEqual([2, 1, 0, 0]);
    const cyc = nestingDepths(new Map([[1, [2]], [2, [1]]]));
    expect(cyc.get(1)).toBeLessThan(5);
  });

  it("weighs a comp by what makes it slow", () => {
    expect(compWeight({ ...noCounts(), layers: 10, effects: 5, expressions: 2, keys: 40 })).toBe(10 + 10 + 6 + 2);
  });

  it("sorts blockers first and keeps the order within a severity", () => {
    const f = (severity: Finding["severity"], code: string): Finding => ({ severity, code, message: code });
    expect(sortFindings([f("note", "a"), f("blocker", "b"), f("warning", "c"), f("blocker", "d"), f("note", "e")]).map((x) => x.code)).toEqual(["b", "d", "c", "a", "e"]);
  });
});

describe("titleSafeHit", () => {
  const c = { id: 1, name: "Main", width: 1000, height: 500 };
  const text = (rect: [number, number, number, number], visible = true): BoundsResult => ({
    layer: { index: 1, id: 7, name: "Title" },
    kind: "text",
    checkable: true,
    reason: null,
    samples: [{ time: 1, visible, rect }],
  });

  it("is quiet for text inside the 20% margin", () => {
    expect(titleSafeHit(text([200, 100, 800, 400]), c, 0.2)).toBeNull();
  });

  it("names the edges and the shift for text past it", () => {
    const hit = titleSafeHit(text([50, 100, 400, 200]), c, 0.2)!;
    expect(hit.past).toEqual(["left by 50 px"]);
    expect(hit.shift).toEqual([50, 0]);
  });

  it("leaves backgrounds, parked-off-frame text, hidden text and non-text alone", () => {
    expect(titleSafeHit(text([0, 0, 1000, 500]), c, 0.2)).toBeNull();
    expect(titleSafeHit(text([-900, 100, -500, 200]), c, 0.2)).toBeNull();
    expect(titleSafeHit(text([10, 100, 300, 200], false), c, 0.2)).toBeNull();
    expect(titleSafeHit({ ...text([10, 100, 300, 200]), kind: "shape" }, c, 0.2)).toBeNull();
  });
});

// ---------- the scan and its rules ----------

describe("ae_preflight delivery", () => {
  const rqItem = (extra: Record<string, unknown> = {}) => ({
    index: 1,
    comp_id: 1,
    comp_name: "Main",
    status: "queued",
    render: true,
    outputs: [{ file: "C:/out/final.mov", folder: "C:/out", folder_exists: true }],
    ...extra,
  });

  function fullWorld() {
    const issues: HostLayerIssue[] = [
      { type: "expression_error", index: 2, layer_id: 22, layer: "Bounce", kind: "solid", path: "Transform > Position", detail: "ReferenceError: foo is not defined" },
      { type: "expression_disabled", index: 3, layer_id: 23, layer: "Wiggle", kind: "solid", path: "Transform > Rotation" },
      { type: "font_missing", index: 1, layer_id: 21, layer: "Title", kind: "text", detail: "Brand-Bold" },
      { type: "effect_unavailable", index: 4, layer_id: 24, layer: "Glow", kind: "solid", path: "Effects > Glow", effect: "Glow X", match_name: "VENDOR Glow X" },
    ];
    return world({
      project: project({
        dirty: true,
        render_queue: { numItems: 2, rendering: false, truncated: false, items: [rqItem({ outputs: [{ file: "C:/missing/final.mov", folder: "C:/missing", folder_exists: false }] }), rqItem({ index: 2, comp_id: 1, render: false, status: "needs_output", outputs: [{ file: null, folder: null, folder_exists: null }] })] },
      }),
      comps: [
        { info: comp(1, "Main", { used_n: 0 }), layers: ["Title", "Bounce", "Wiggle", "Glow"], issues, precomps: [2], counts: { effects: 1, expressions: 2 } },
        { info: comp(2, "Comp 2", { used_n: 1, used_in: [1] }), layers: ["Solid 1", "BG"] },
        { info: comp(3, "Other", { used_n: 0 }), layers: ["x"] },
      ],
      footage: [
        footage(10, "plate.mov", { missing: true, used_in: [1] }),
        footage(11, "old.mov", { missing: true, used_n: 0, used_in: [] }),
        footage(12, "placeholder", { kind: "placeholder", file: null, missing: true, used_in: [2] }),
        footage(13, "proxied.mov", { used_in: [1], proxy: { use: true, file: "C:/proxy/p.mov", missing: false } }),
        footage(14, "elsewhere.mov", { missing: true, used_in: [3] }),
        footage(15, "fine.mov", { used_in: [1] }),
      ],
    });
  }

  it("ranks blockers first and names a fix for every finding it can", async () => {
    const { ctx, calls } = fakeAe(fullWorld());
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.cursor).toBeUndefined();
    expect(r.verdict).toBe("blocked");
    // Reads only: nothing but the preflight host functions ran.
    expect(calls.every((c) => PREFLIGHT_HOSTS.has(c.fn))).toBe(true);
    // Blockers come before warnings come before notes.
    const order = r.findings.map((f: Finding) => f.severity);
    expect(order).toEqual([...order].sort((a: string, b: string) => ["blocker", "warning", "note"].indexOf(a) - ["blocker", "warning", "note"].indexOf(b)));

    const blockers = r.findings.filter((f: Finding) => f.severity === "blocker").map((f: Finding) => f.code);
    expect(blockers).toEqual(expect.arrayContaining(["output_missing", "footage_missing", "footage_placeholder", "font_missing", "expression_error"]));
    expect(find(r, "footage_missing").filter((f) => f.severity === "blocker").map((f) => f.where?.item)).toEqual(["plate.mov"]);

    const warnings = r.findings.filter((f: Finding) => f.severity === "warning").map((f: Finding) => f.code);
    expect(warnings).toEqual(expect.arrayContaining(["unsaved_changes", "output_folder_missing", "proxy_in_use", "expression_disabled", "effect_unavailable"]));
    // Comp 2 (nested) and the layer "Solid 1" are notes; only a final comp's default name is a warning.
    expect(find(r, "default_name").map((f) => f.severity)).toEqual(["note", "note"]);
    expect(find(r, "effect_unavailable")[0].confidence).toBe("low");
    expect(find(r, "unsaved_changes")[0].fix).toMatchObject({ tool: "ae_save" });
    expect(find(r, "footage_missing").find((f) => f.where?.item === "plate.mov")!.fix).toMatchObject({ tool: "ae_replace_footage" });
    expect(find(r, "expression_error")[0].fix).toMatchObject({ tool: "ae_validate_expressions", args: { comp_id: 1, layer: { id: 22 } } });
  });

  it("separates missing footage the checked comps use from footage nothing here uses", async () => {
    const { ctx } = fakeAe(fullWorld());
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    const notes = find(r, "footage_missing").filter((f) => f.severity === "note");
    expect(notes.map((f) => f.where?.item).sort()).toEqual(["elsewhere.mov", "old.mov"]);
    expect(notes.find((f) => f.where?.item === "elsewhere.mov")!.message).toContain("outside this check");
    expect(find(r, "unused_items")[0].fix).toMatchObject({ tool: "ae_purge_unused" });
  });

  it("scans the render queue's comps and what they nest, not the unrelated comp", async () => {
    const { ctx, calls } = fakeAe(fullWorld());
    await tool.handler(AePreflightSchema.parse({}), ctx);
    const scanned = calls.filter((c) => c.fn === "preflightLayers").map((c) => c.args.comp_id);
    expect(scanned).toEqual([1, 2]);
    // Title safe wants text candidates for the final comp only.
    expect(calls.filter((c) => c.fn === "preflightLayers").map((c) => c.args.text_candidates)).toEqual([true, false]);
  });

  it("flags default comp names: warning on the final comp, one note for nested ones", async () => {
    const { ctx } = fakeAe(
      world({ project: project({ render_queue: { numItems: 1, rendering: false, truncated: false, items: [rqItem({ comp_id: 5, comp_name: "Comp 1" })] } }), comps: [{ info: comp(5, "Comp 1"), layers: ["a"], precomps: [6] }, { info: comp(6, "Pre-comp 2", { used_n: 1, used_in: [5] }), layers: ["b"] }] })
    );
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    const names = find(r, "default_name");
    expect(names.map((f) => f.severity)).toEqual(["warning", "note"]);
    expect(names[0].where?.comp).toBe("Comp 1");
    expect(names[1].message).toContain("Pre-comp 2");
  });

  it("applies a custom naming template and warns about duplicate comp names", async () => {
    const { ctx } = fakeAe(
      world({
        project: project({ render_queue: { numItems: 1, rendering: false, truncated: false, items: [rqItem({ comp_id: 1, comp_name: "Main" })] } }),
        comps: [{ info: comp(1, "Main"), layers: ["a"] }, { info: comp(2, "Main"), layers: ["b"] }],
      })
    );
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { template: "{word}_{ver}", apply_to: ["comps"] } }), ctx)) as any;
    expect(find(r, "name_rule_broken")).toHaveLength(1);
    expect(find(r, "name_rule_broken")[0].message).toContain('does not match template "{word}_{ver}"');
    expect(find(r, "duplicate_comp_name")[0].severity).toBe("warning");
  });

  it("checks title safe on the final comp's text at the comp's time", async () => {
    const bounds = (a: any): BoundsResult => ({
      layer: { index: 1, id: a.layer.id, name: "Headline" },
      kind: "text",
      checkable: true,
      reason: null,
      samples: [{ time: a.times[0], visible: true, rect: [20, 100, 400, 200] }],
    });
    const { ctx, calls } = fakeAe(
      world({
        project: project({ render_queue: { numItems: 1, rendering: false, truncated: false, items: [rqItem({ comp_id: 1, comp_name: "Main" })] } }),
        comps: [{ info: comp(1, "Main", { width: 1000, height: 500 }), layers: ["Headline"], texts: [{ index: 1, id: 31, name: "Headline" }] }],
        bounds,
      })
    );
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    const hit = find(r, "text_outside_title_safe");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("warning");
    expect(hit[0].fix).toMatchObject({ tool: "ae_align", args: { comp_id: 1, to: "title_safe", align: "left" } });
    expect(calls.find((c) => c.fn === "layerBoundsAt")!.args).toMatchObject({ comp_id: 1, layer: { id: 31 }, times: [1] });
    // And it can be switched off.
    const off = fakeAe(world({ project: project({ render_queue: { numItems: 1, rendering: false, truncated: false, items: [rqItem()] } }), comps: [{ info: comp(1, "Main"), layers: ["Headline"], texts: [{ index: 1, id: 31, name: "Headline" }] }] }));
    await tool.handler(AePreflightSchema.parse({ check_title_safe: false }), off.ctx);
    expect(off.calls.some((c) => c.fn === "layerBoundsAt")).toBe(false);
  });

  it("checks that a queued output's folder exists in Node as well: a planned output in a missing folder warns", () => {
    const missing = path.join(os.tmpdir(), "chroma-preflight-does-not-exist", "x.mov");
    const s = newScanState(normaliseOptions({}, missing));
    s.project = project();
    expect(buildFindings(s).map((f) => f.code)).toContain("output_folder_missing");
    const here = newScanState(normaliseOptions({}, path.join(os.tmpdir(), "x.mov")));
    here.project = project();
    expect(buildFindings(here).map((f) => f.code)).not.toContain("output_folder_missing");
  });

  it("reports an unsaved project, and a clear project as clear", async () => {
    const unsaved = fakeAe(world({ project: project({ saved: false, project_path: "<unsaved>", dirty: true }), comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const u = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), unsaved.ctx)) as any;
    expect(codes(u)).toContain("project_unsaved");
    expect(codes(u)).not.toContain("unsaved_changes");
    const ok = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }], footage: [footage(2, "plate.mov", { used_in: [1] })] }));
    const c = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ok.ctx)) as any;
    expect(c.verdict).toBe("clear");
    expect(c.findings).toEqual([]);
  });

  it("blocks on a comp name that is not in the project", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ comp_names: ["Nope"] }), ctx)) as any;
    expect(r.verdict).toBe("blocked");
    expect(find(r, "comp_not_found")[0].message).toContain('"Nope"');
  });

  it("passes force_eval to the host, and says which way expressions were read", async () => {
    const { ctx, calls } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const forced = (await tool.handler(AePreflightSchema.parse({ force_eval: true }), ctx)) as any;
    expect(calls.find((c) => c.fn === "preflightLayers")!.args.force_eval).toBe(true);
    expect(forced.checked.expressions).toMatch(/forced evaluation/);
    const cheap = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({}), cheap.ctx)) as any;
    expect(cheap.calls.find((c) => c.fn === "preflightLayers")!.args.force_eval).toBe(false);
    expect(r.checked.expressions).toMatch(/already holds/);
  });

  it("notes that the effects and font checks were skipped when the host could not read them", async () => {
    const { ctx } = fakeAe(world({ project: project({ effects_check: "unavailable", fonts_check: "unavailable" }), comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    expect(codes(r)).toContain("effects_check_skipped");
    expect(r.checked.effects).toMatch(/skipped/);
  });
});

// ---------- paging ----------

describe("ae_preflight paging", () => {
  const big = () => {
    const names = Array.from({ length: 65 }, (_, i) => `L${i + 1}`);
    const many = Array.from({ length: 160 }, (_, i) => footage(100 + i, `f${i}.mov`, { used_in: [1], missing: i === 159 }));
    return world({ comps: [{ info: comp(1, "Main"), layers: names, issues: [{ type: "expression_error", index: 1, layer_id: 9, layer: "L1", kind: "solid", path: "Opacity", detail: "bad" }] }], footage: many });
  };

  it("reads a big project in slices and returns the same report under a cursor", async () => {
    const whole = fakeAe(big());
    const full = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), whole.ctx)) as any;
    expect(full.complete).toBe(true);
    // project + 2 item pages (161 items, 150 each) + 3 layer pages (65 layers, 30 each).
    expect(whole.calls.map((c) => c.fn)).toEqual(["preflightProject", "preflightItems", "preflightItems", "preflightLayers", "preflightLayers", "preflightLayers"]);

    const paged = fakeAe(big());
    const first = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true }, max_slices: 2 }), paged.ctx)) as any;
    expect(first.complete).toBe(false);
    expect(first.verdict).toBe("incomplete");
    expect(first.cursor).toMatch(/^pf_[0-9a-f]{10}$/);
    expect(first.progress.items_total).toBe(161);
    let last = first;
    let guard = 0;
    while (!last.complete && guard++ < 10) last = (await tool.handler(AePreflightSchema.parse({ cursor: last.cursor, max_slices: 2 }), paged.ctx)) as any;
    expect(last.complete).toBe(true);
    expect(last.findings.map((f: Finding) => f.code)).toEqual(full.findings.map((f: Finding) => f.code));
    expect(last.verdict).toBe("blocked");
    // Each host call stayed one slice: no call asked for more than a slice.
    expect(paged.calls.filter((c) => c.fn === "preflightLayers").every((c) => c.args.limit <= 30)).toBe(true);
    expect(paged.calls.filter((c) => c.fn === "preflightItems").every((c) => c.args.limit <= 150)).toBe(true);
    // A finished scan frees its cursor.
    const again = (await tool.handler(AePreflightSchema.parse({ cursor: first.cursor }), paged.ctx)) as any;
    expect(again).toMatchObject({ ok: false, error: "cursor_unknown" });
  });

  it("shows blockers found so far while the scan is incomplete", async () => {
    const h = world({
      comps: [{ info: comp(1, "Main"), layers: Array.from({ length: 65 }, (_, i) => `L${i}`), issues: [{ type: "expression_error", index: 1, layer_id: 9, layer: "L0", kind: "solid", path: "Opacity", detail: "bad" }] }],
    });
    const { ctx } = fakeAe(h);
    const r = (await tool.handler(AePreflightSchema.parse({ max_slices: 3, naming: { allow_default_names: true } }), ctx)) as any;
    expect(r.complete).toBe(false);
    expect(r.verdict).toBe("blocked");
    expect(codes(r)).toContain("expression_error");
    expect(r.cursor).toBeDefined();
  });

  it("refuses a cursor once the open project has changed", async () => {
    const h = big();
    const { ctx } = fakeAe(h);
    const first = (await tool.handler(AePreflightSchema.parse({ max_slices: 1 }), ctx)) as any;
    expect(first.cursor).toBeDefined();
    h.status = () => ({ project_path: "C:/Projects/Other.aep" });
    const r = (await tool.handler(AePreflightSchema.parse({ cursor: first.cursor }), ctx)) as any;
    expect(r).toMatchObject({ ok: false, error: "cursor_stale" });
  });

  it("always runs one slice, whatever the budget", async () => {
    const { ctx, calls } = fakeAe(big());
    await tool.handler(AePreflightSchema.parse({ budget_ms: 1000, max_slices: 1 }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["preflightProject"]);
  });
});

// ---------- health ----------

describe("ae_preflight health", () => {
  it("maps the project: heaviest comps, nesting, duplicates, huge comps, settings", async () => {
    const { ctx, calls } = fakeAe(
      world({
        project: project({ bits_per_channel: 8, linear_blending: false }),
        comps: [
          { info: comp(1, "Master", { renderer: "ADBE Advanced 3d" }), layers: ["a", "b"], precomps: [2], counts: { effects: 20, expressions: 5, keys: 100, three_d: 2 } },
          { info: comp(2, "Mid", { used_n: 1, used_in: [1] }), layers: ["c"], precomps: [3], counts: { effects: 1 } },
          { info: comp(3, "Leaf", { used_n: 1, used_in: [2] }), layers: ["d"], precomps: [4] },
          { info: comp(4, "Deep", { used_n: 1, used_in: [3], width: 16000, height: 9000 }), layers: ["e"] },
        ],
        footage: [footage(10, "a.mov", { file: "C:/m/A.mov", used_in: [1] }), footage(11, "a copy.mov", { file: process.platform === "win32" ? "c:/m/a.mov" : "C:/m/A.mov", used_in: [2] }), footage(12, "unused.mov", { used_n: 0, used_in: [] })],
      })
    );
    const r = (await tool.handler(AePreflightSchema.parse({ scope: "health", max_nesting: 2, top: 2, naming: { allow_default_names: true }, project_spec: { bits_per_channel: 16, linear_blending: true } }), ctx)) as any;
    expect(r.scope).toBe("health");
    // Health does not measure title safe unless asked.
    expect(calls.some((c) => c.fn === "layerBoundsAt")).toBe(false);
    expect(r.health.heaviest_comps.map((c: any) => c.comp)).toEqual(["Master", "Mid"]);
    expect(r.health.heaviest_comps[0].weight).toBeGreaterThan(r.health.heaviest_comps[1].weight);
    expect(r.health.totals).toMatchObject({ comps: 4, footage: 3, layers: 5, effects: 21, expressions: 5, keys: 100 });
    expect(r.health.max_nesting_depth).toBe(3);
    expect(r.health.renderers).toEqual({ "ADBE Advanced 3d": 4 });
    expect(r.health.comps_with_3d_layers).toEqual([{ comp_id: 1, comp: "Master", three_d_layers: 2, renderer: "ADBE Advanced 3d" }]);
    expect(r.health.unused.footage).toBe(1);
    expect(find(r, "deep_nesting").map((f) => f.where?.comp)).toEqual(["Master"]);
    expect(find(r, "duplicate_footage")).toHaveLength(1);
    expect(find(r, "huge_comp")[0].where?.comp).toBe("Deep");
    expect(find(r, "project_setting_differs")).toHaveLength(2);
    expect(r.health.settings.note).toMatch(/project-level/);
  });

  it("does not add a health section to the delivery scope", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["a"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    expect(r.health).toBeUndefined();
  });
});

// ---------- the gate and the render tools ----------

describe("runPreflightGate", () => {
  const blockedWorld = () =>
    world({
      comps: [{ info: comp(1, "Main"), layers: ["Bounce"], issues: [{ type: "expression_error", index: 1, layer_id: 2, layer: "Bounce", kind: "solid", path: "Position", detail: "boom" }] }],
    });
  const cleanWorld = () => world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }], footage: [footage(2, "plate.mov", { used_in: [1] })] });

  it("blocks on a blocker and builds the refusal", async () => {
    const { ctx } = fakeAe(blockedWorld());
    const gate = await runPreflightGate(ctx, { toolName: "ae_render_queue_add", opId: "op_1", comp_ids: [1] });
    expect(gate.blocked).toBe(true);
    expect(gate.summary.verdict).toBe("blocked");
    expect(gate.summary.blockers[0].code).toBe("expression_error");
    const refusal = preflightRefusal("ae_render_queue_add", gate.summary);
    expect(refusal).toMatchObject({ ok: false, error: "preflight_blocked", kind: "preflight", applied: false });
    expect(refusal.message).toContain("1 blocker");
  });

  it("lets a clean comp through and reports an unfinished scan as incomplete, not blocked", async () => {
    const { ctx } = fakeAe(cleanWorld());
    const gate = await runPreflightGate(ctx, { toolName: "ae_aerender_start", opId: "op_2", comp_names: ["Main"] });
    expect(gate.blocked).toBe(false);
    expect(gate.summary.complete).toBe(true);
    expect(gate.summary.comps_checked).toBe(1);
  });

  it("ae_render_queue_add with preflight refuses before writing anything", async () => {
    const h = blockedWorld();
    h.checkGuard = () => ({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
    const { ctx, calls } = fakeAe(h);
    const add = renderTools.find((t) => t.name === "ae_render_queue_add")!;
    const out = (await add.handler(add.schema.parse({ comp_id: 1, output_path: path.join(os.tmpdir(), "o.mov"), preflight: true, expect: { project_path: "<unsaved>" } }), ctx)) as any;
    expect(out).toMatchObject({ ok: false, error: "preflight_blocked", applied: false });
    expect(calls.map((c) => c.fn)).not.toContain("rqAdd");
    expect(calls.map((c) => c.fn)).not.toContain("rqStatus");
  });

  it("ae_render_queue_add with preflight adds the comp when the check passes, and shows the summary", async () => {
    const h = cleanWorld();
    h.checkGuard = () => ({ ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true });
    h.rqStatus = () => ({ numItems: 0, rendering: false, items: [] });
    h.rqAdd = () => ({ index: 1, comp_id: 1, output: "o.mov" });
    const { ctx, calls } = fakeAe(h);
    const add = renderTools.find((t) => t.name === "ae_render_queue_add")!;
    const out = (await add.handler(add.schema.parse({ comp_id: 1, output_path: path.join(os.tmpdir(), "o.mov"), preflight: true, expect: { project_path: "<unsaved>" } }), ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.preflight).toMatchObject({ verdict: expect.stringMatching(/clear|warnings/), complete: true });
    const fns = calls.map((c) => c.fn);
    expect(fns.indexOf("preflightProject")).toBeLessThan(fns.indexOf("rqAdd"));
    // Without the option nothing preflight runs.
    const plain = fakeAe(h);
    await add.handler(add.schema.parse({ comp_id: 1, output_path: path.join(os.tmpdir(), "o.mov"), expect: { project_path: "<unsaved>" } }), plain.ctx);
    expect(plain.calls.some((c) => c.fn === "preflightProject")).toBe(false);
  });

  it("ae_aerender_start with preflight refuses before spawning", async () => {
    const h = blockedWorld();
    h.status = () => ({ aeVersion: "26.0", project_path: "C:\\Projects\\Demo.aep", dirty: false });
    const { ctx, dir } = fakeAe(h);
    let spawned = false;
    const tools = createAerenderTools({
      platform: "win32",
      existsSync: () => true,
      spawn: () => {
        spawned = true;
        throw new Error("should not spawn");
      },
    });
    const start = tools.find((t) => t.name === "ae_aerender_start")!;
    const out = (await start.handler(start.schema.parse({ expect: { project_path: EXPECT_DEMO }, comp_name: "Main", output_path: path.join(dir, "o.mov"), preflight: true }), ctx)) as any;
    expect(out).toMatchObject({ ok: false, error: "preflight_blocked" });
    expect(spawned).toBe(false);
  });
});

describe("review fixes", () => {
  const rqItem = (extra: Record<string, unknown> = {}) => ({
    index: 1,
    comp_id: 1,
    comp_name: "Main",
    status: "queued",
    render: true,
    outputs: [{ file: "C:/out/final.mov", folder: "C:/out", folder_exists: true }],
    ...extra,
  });
  const oldItemWorld = () =>
    world({
      project: project({ render_queue: { numItems: 1, rendering: false, truncated: false, items: [rqItem({ render: false, status: "needs_output", outputs: [{ file: null, folder: null, folder_exists: null }] })] } }),
      comps: [{ info: comp(1, "Main"), layers: ["BG"] }],
    });

  it("the gate ignores an old queue item without output; ae_preflight still reports it", async () => {
    const { ctx } = fakeAe(oldItemWorld());
    const gate = await runPreflightGate(ctx, { toolName: "ae_render_queue_add", opId: "op_q", comp_ids: [1], planned_output: path.join(os.tmpdir(), "x.mov") });
    expect(gate.blocked).toBe(false);
    expect(gate.summary.blockers).toEqual([]);
    const plain = fakeAe(oldItemWorld());
    const r = (await tool.handler(AePreflightSchema.parse({ comp_ids: [1] }), plain.ctx)) as any;
    expect(codes(r)).toContain("output_missing");
  });

  it("the gate still checks the planned output's folder", async () => {
    const { ctx } = fakeAe(oldItemWorld());
    const gate = await runPreflightGate(ctx, { toolName: "ae_render_queue_add", opId: "op_p", comp_ids: [1], planned_output: path.join(os.tmpdir(), "no-such-dir-xyz", "x.mov") });
    expect(gate.summary.warnings.map((w) => w.code)).toContain("output_folder_missing");
  });

  it("an expression_unchecked issue is a low-confidence note, never a blocker", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["Fx"], issues: [{ type: "expression_unchecked", index: 1, layer_id: 5, layer: "Fx", kind: "solid", path: "Effects > Colorama > Output Cycle", detail: "has not been implemented" }] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ force_eval: true, naming: { allow_default_names: true } }), ctx)) as any;
    expect(find(r, "expression_unchecked")[0]).toMatchObject({ severity: "note", confidence: "low" });
    expect(r.verdict).not.toBe("blocked");
  });

  it("says when force_eval only forced part of the expressions", async () => {
    const h = world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }] });
    const base = h.preflightLayers;
    h.preflightLayers = (a) => ({ ...(base(a) as LayersPage), forced_evals: 200, force_capped: 40 });
    const { ctx } = fakeAe(h);
    const r = (await tool.handler(AePreflightSchema.parse({ force_eval: true, naming: { allow_default_names: true } }), ctx)) as any;
    expect(find(r, "force_eval_partial")[0]).toMatchObject({ severity: "note", count: 40 });
    expect(r.checked.expressions).toMatch(/200 of 240/);
  });

  it("a scan's cursor expires 15 minutes after its last use, not after its start", async () => {
    const big = () => world({ comps: [{ info: comp(1, "Main"), layers: Array.from({ length: 200 }, (_, i) => "L" + i) }] });
    const { ctx } = fakeAe(big());
    const real = Date.now;
    let now = real();
    Date.now = () => now;
    try {
      let r = (await tool.handler(AePreflightSchema.parse({ max_slices: 2 }), ctx)) as any;
      expect(r.cursor).toBeDefined();
      for (let i = 0; i < 3; i++) {
        now += 10 * 60 * 1000;
        r = (await tool.handler(AePreflightSchema.parse({ cursor: r.cursor, max_slices: 1 }), ctx)) as any;
        expect(r.ok).toBe(true);
      }
      // 30 minutes after the start, but each call was within 15 minutes of the last.
      now += 16 * 60 * 1000;
      const gone = (await tool.handler(AePreflightSchema.parse({ cursor: r.cursor }), ctx)) as any;
      expect(gone).toMatchObject({ ok: false, error: "cursor_unknown" });
    } finally {
      Date.now = real;
    }
  });

  it("layer naming points at ae_layer_ops rename; comps keep ae_run_jsx", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Comp 1"), layers: ["Solid 1", "Null 2"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    const layerFix = find(r, "default_name").find((f: Finding) => f.where?.comp_id === 1 && /layer/.test(f.message))!;
    expect(layerFix.fix).toMatchObject({ tool: "ae_layer_ops", args: { action: "rename", comp_id: 1 } });
    expect(JSON.stringify(r.findings)).not.toContain("no typed rename tool");
    const compFix = find(r, "default_name").find((f: Finding) => /Comp "Comp 1"/.test(f.message))!;
    expect(compFix.fix?.tool).toBe("ae_run_jsx");
  });

  it("comp_names entries are capped at 200 characters", () => {
    expect(AePreflightSchema.safeParse({ comp_names: ["x".repeat(201)] }).success).toBe(false);
    expect(AePreflightSchema.safeParse({ comp_names: ["x".repeat(200)] }).success).toBe(true);
  });

  it("a duplicate name given in comp_names is reported once", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["a"] }, { info: comp(2, "Main"), layers: ["b"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ comp_names: ["Main"], naming: { allow_default_names: true } }), ctx)) as any;
    expect(find(r, "duplicate_comp_name")).toHaveLength(1);
  });

  it("a needs_output queue item (render false) is a delivery root and an output_missing blocker", async () => {
    const { ctx } = fakeAe(oldItemWorld());
    const r = (await tool.handler(AePreflightSchema.parse({}), ctx)) as any;
    const f = find(r, "output_missing");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("blocker");
    expect(r.checked.comps.map((c: any) => c.id)).toEqual([1]);
  });

  it("a proxy on footage nothing uses raises no warning", async () => {
    const { ctx } = fakeAe(world({ footage: [footage(13, "proxied.mov", { used_n: 0, used_in: [], proxy: { use: true, file: "C:/proxy/p.mov", missing: true } })], comps: [{ info: comp(1, "Main"), layers: ["a"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    expect(codes(r)).not.toContain("proxy_in_use");
    expect(codes(r)).not.toContain("proxy_file_missing");
  });

  it("the gate says how it read expressions", async () => {
    const { ctx, calls } = fakeAe(oldItemWorld());
    const gate = await runPreflightGate(ctx, { toolName: "ae_render_queue_add", opId: "op_e", comp_ids: [1] });
    expect(gate.summary.expressions).toMatch(/forced evaluation/);
    expect((calls.find((c: any) => c.fn === "preflightLayers") as any).args.force_eval).toBe(true);
  });

  it("reports a comp whose proxy is on", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main", { proxy: { use: true, file: "C:/p/comp.mov", missing: false } }), layers: ["a"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    expect(find(r, "proxy_in_use")[0]).toMatchObject({ severity: "warning", where: { comp_id: 1 } });
  });

  it("an unlisted ADBE-prefixed effect is a note, a vendor one stays a warning", async () => {
    const issues: HostLayerIssue[] = [
      { type: "effect_unavailable", index: 1, layer_id: 5, layer: "A", kind: "solid", effect: "Odd", match_name: "ADBE Odd Thing" },
      { type: "effect_unavailable", index: 2, layer_id: 6, layer: "B", kind: "solid", effect: "Glow X", match_name: "VENDOR Glow X" },
    ];
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["A", "B"], issues }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    const sev = Object.fromEntries(find(r, "effect_unavailable").map((f: Finding) => [f.message.includes("Odd") ? "adbe" : "vendor", f.severity]));
    expect(sev).toEqual({ adbe: "note", vendor: "warning" });
  });
});

// ---------- the host functions under node:vm ----------

describe("preflight.jsx", () => {
  type Any = any;

  function scene() {
    const proj = new FakeProject() as Any;
    proj.file = { fsName: "C:/Projects/Demo.aep" };
    proj.dirty = true;
    proj.bitsPerChannel = 16;
    proj.workingSpace = "sRGB IEC61966-2.1";
    proj.linearBlending = true;
    proj.expressionEngine = "javascript-1.0";
    const main = proj.addComp("Main", 1000, 500, 4) as Any;
    main.renderer = "ADBE Advanced 3d";
    Object.defineProperty(main, "usedIn", { get: () => [] });
    return { proj, main };
  }

  function host(proj: Any, extra: Record<string, unknown> = {}) {
    const loaded = loadHost(proj, ["preflight.jsx"], {
      effects: [{ matchName: "ADBE Gaussian Blur 2" }, { matchName: "ADBE Fill" }],
      fonts: { missingOrSubstitutedFonts: [{ postScriptName: "Brand-Bold" }] },
      ...extra,
    });
    loaded.G.RQItemStatus = { WILL_CONTINUE: 1, NEEDS_OUTPUT: 2, UNQUEUED: 3, QUEUED: 4, RENDERING: 5, USER_STOPPED: 6, ERR_STOPPED: 7, DONE: 8 };
    return loaded;
  }

  const effectGroup = (layer: Any) => layer.group.property("ADBE Effect Parade") as FakeGroup;
  function addEffect(layer: Any, name: string, matchName: string) {
    const fx = new FakeGroup(name, matchName, [new FakeProperty("Amount", `${matchName}-0001`, PropertyValueType.OneD, 0)]);
    const parade = effectGroup(layer);
    fx.parentProperty = parade;
    parade.props.push(fx);
    return fx;
  }

  it("preflightProject never reports the literal name 'undefined' for a font", () => {
    const { proj } = scene();
    proj.renderQueue = { numItems: 0, rendering: false, item: () => ({}) };
    const { A } = host(proj, { fonts: { missingOrSubstitutedFonts: [{ nativeFullName: "Brand Bold" }, { postScriptName: undefined }, { postScriptName: null, nativeFullName: null }] } });
    expect(A.preflightProject().missing_fonts).toEqual(["Brand Bold"]);
  });

  it("preflightProject reports settings, unsaved changes, fonts and the render queue", () => {
    const { proj, main } = scene();
    proj.renderQueue = {
      numItems: 2,
      rendering: false,
      item: (i: number) =>
        i === 1
          ? { comp: main, status: 4, render: true, numOutputModules: 1, outputModule: () => ({ file: { fsName: "C:/out/final.mov", parent: { fsName: "C:/out", exists: false } } }) }
          : { comp: main, status: 2, render: false, numOutputModules: 1, outputModule: () => ({ file: null }) },
    };
    const { A } = host(proj);
    const p = A.preflightProject();
    expect(p).toMatchObject({ project_path: "C:/Projects/Demo.aep", saved: true, dirty: true, bits_per_channel: 16, linear_blending: true, installed_effects: 2, effects_check: "available", fonts_check: "available", missing_fonts: ["Brand-Bold"] });
    expect(p.render_queue.items[0]).toMatchObject({ index: 1, comp_id: main.id, status: "queued", render: true, outputs: [{ file: "C:/out/final.mov", folder: "C:/out", folder_exists: false }] });
    expect(p.render_queue.items[1]).toMatchObject({ status: "needs_output", render: false, outputs: [{ file: null }] });
  });

  it("preflightProject copes with AE that has no font list or effect list", () => {
    const { proj } = scene();
    const { A } = host(proj, { effects: undefined, fonts: undefined });
    const p = A.preflightProject();
    expect(p).toMatchObject({ effects_check: "unavailable", fonts_check: "unavailable", missing_fonts: [] });
  });

  it("preflightItems pages comps and footage with usage, missing files and proxies", () => {
    const { proj, main } = scene();
    const lost = proj.addFootage("lost.mov", 100, 100, new FileSource()) as FakeFootage & Any;
    lost.footageMissing = true;
    lost.file = { fsName: "C:/media/lost.mov" };
    const ph = proj.addFootage("holder", 100, 100, new PlaceholderSource()) as Any;
    ph.footageMissing = true;
    const solid = proj.addFootage("Red Solid 1", 100, 100, new SolidSource()) as Any;
    const prox = proj.addFootage("proxied.mov", 100, 100, new FileSource()) as Any;
    prox.proxySource = { file: { fsName: "C:/proxy/p.mov" }, missingFootagePath: "" };
    prox.useProxy = true;
    main.layers.add(lost);
    void solid;
    const { A } = host(proj);
    const page1 = A.preflightItems({ offset: 0, limit: 3 });
    expect(page1).toMatchObject({ offset: 0, total: 5, next_offset: 3 });
    expect(page1.comps[0]).toMatchObject({ name: "Main", width: 1000, renderer: "ADBE Advanced 3d", used_n: 0 });
    expect(page1.footage.map((f: Any) => [f.name, f.kind, f.missing])).toEqual([
      ["lost.mov", "footage", true],
      ["holder", "placeholder", true],
    ]);
    expect(page1.footage[0]).toMatchObject({ used_n: 1, used_in: [main.id], file: "C:/media/lost.mov" });
    const page2 = A.preflightItems({ offset: 3, limit: 3 });
    expect(page2.next_offset).toBeNull();
    expect(page2.footage.map((f: Any) => f.kind)).toEqual(["solid", "footage"]);
    expect(page2.footage[1].proxy).toEqual({ use: true, file: "C:/proxy/p.mov", missing: false });
    expect(page2.footage[0].proxy).toBeNull();
  });

  it("preflightLayers finds expressions in error, disabled expressions and counts keys", () => {
    const { proj, main } = scene();
    const a = main.layers.addSolid([1, 1, 1], "Bounce", 100, 100, 1) as Any;
    const opacity = a.transform("ADBE Opacity");
    opacity.expression = "foo";
    opacity.expressionEnabled = true;
    opacity.expressionError = "ReferenceError: foo is not defined";
    const rot = a.transform("ADBE Rotate Z");
    rot.expression = "wiggle(1,1)";
    rot.expressionEnabled = false;
    const pos = a.transform("ADBE Position");
    pos.expression = "ok";
    pos.expressionEnabled = true;
    const scale = a.transform("ADBE Scale");
    scale.setValueAtTime(0, [100, 100, 100]);
    scale.setValueAtTime(1, [120, 120, 120]);
    const { A, undo } = host(proj);
    const r = A.preflightLayers({ comp_id: main.id });
    expect(r.counts).toMatchObject({ layers: 1, expressions: 3, keys: 2 });
    const types = r.issues.map((i: Any) => i.type).sort();
    expect(types).toEqual(["expression_disabled", "expression_error"]);
    const err = r.issues.find((i: Any) => i.type === "expression_error");
    expect(err).toMatchObject({ layer: "Bounce", path: "Transform > Opacity", detail: "ReferenceError: foo is not defined" });
    // A read: no undo group opened.
    expect(undo.begun).toBe(0);
  });

  it("force_eval evaluates enabled expressions at the comp's time; a throw with no AE error is unchecked, not an error", () => {
    const { proj, main } = scene();
    const a = main.layers.addSolid([1, 1, 1], "Boom", 100, 100, 1) as Any;
    const opacity = a.transform("ADBE Opacity");
    opacity.expression = "bad";
    opacity.expressionEnabled = true;
    const times: number[] = [];
    opacity.valueAtTime = (t: number) => {
      times.push(t);
      throw new Error("Expression result is undefined");
    };
    main.time = 2;
    const { A } = host(proj);
    const cheap = A.preflightLayers({ comp_id: main.id });
    expect(cheap.issues).toEqual([]);
    expect(times).toEqual([]);
    const forced = A.preflightLayers({ comp_id: main.id, force_eval: true });
    expect(forced.issues[0]).toMatchObject({ type: "expression_unchecked", detail: "Expression result is undefined" });
    expect(forced.forced_evals).toBe(1);
    expect(times).toEqual([2]);
    expect(main.time).toBe(2);
    // When AE holds an error after the read, it is an error.
    opacity.expressionError = "ReferenceError: bad is not defined";
    const err = A.preflightLayers({ comp_id: main.id, force_eval: true });
    expect(err.issues[0]).toMatchObject({ type: "expression_error", detail: "ReferenceError: bad is not defined" });
  });

  it("force_eval does not read CUSTOM_VALUE properties", () => {
    const { proj, main } = scene();
    const a = main.layers.addSolid([1, 1, 1], "Cust", 100, 100, 1) as Any;
    const fx = addEffect(a, "Colorama", "ADBE Fill") as Any;
    const prop = fx.props[0] as Any;
    prop.propertyValueType = PropertyValueType.CUSTOM_VALUE;
    prop.expression = "thisComp.layer(1).effect(1)(1)";
    prop.expressionEnabled = true;
    let reads = 0;
    prop.valueAtTime = () => {
      reads++;
      throw new Error("has not been implemented");
    };
    const { A } = host(proj);
    const r = A.preflightLayers({ comp_id: main.id, force_eval: true });
    expect(reads).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.forced_evals).toBe(0);
  });

  it("force_eval stops forcing at 200 per slice and reports how many it skipped", () => {
    const { proj, main } = scene();
    const a = main.layers.addSolid([1, 1, 1], "Many", 100, 100, 1) as Any;
    const fx = new FakeGroup("Pile", "ADBE Fill", []);
    const parade = effectGroup(a);
    fx.parentProperty = parade;
    parade.props.push(fx);
    for (let i = 0; i < 205; i++) {
      const q = new FakeProperty("P" + i, "ADBE Fill-" + i, PropertyValueType.OneD, 0) as Any;
      q.expression = "1";
      q.expressionEnabled = true;
      q.parentProperty = fx;
      fx.props.push(q);
    }
    const { A } = host(proj);
    const r = A.preflightLayers({ comp_id: main.id, force_eval: true });
    expect(r.counts.expressions).toBe(205);
    expect(r.forced_evals).toBe(200);
    expect(r.force_capped).toBe(5);
  });

  it("does not flag the built-in effects AE hides from the Effect menu", () => {
    const { proj, main } = scene();
    const a = main.layers.addSolid([1, 1, 1], "Hidden", 100, 100, 1) as Any;
    addEffect(a, "Paint", "ADBE Paint");
    addEffect(a, "Puppet", "ADBE FreePin3");
    const { A } = host(proj);
    expect(A.preflightLayers({ comp_id: main.id }).issues).toEqual([]);
  });

  it("preflightItems reports a comp's proxy", () => {
    const { proj, main } = scene();
    main.proxySource = { file: { fsName: "C:/proxy/comp.mov" }, missingFootagePath: "" };
    main.useProxy = true;
    const { A } = host(proj);
    const page = A.preflightItems({ offset: 0, limit: 10 });
    expect(page.comps[0].proxy).toEqual({ use: true, file: "C:/proxy/comp.mov", missing: false });
  });

  it("flags an effect that is not installed, but not an installed one or a pseudo effect", () => {
    const { proj, main } = scene();
    const a = main.layers.addSolid([1, 1, 1], "Fx", 100, 100, 1) as Any;
    addEffect(a, "Gaussian Blur", "ADBE Gaussian Blur 2");
    addEffect(a, "Glow X", "VENDOR Glow X");
    addEffect(a, "Preset Control", "Pseudo/ABC");
    const { A } = host(proj);
    const r = A.preflightLayers({ comp_id: main.id });
    expect(r.counts.effects).toBe(3);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ type: "effect_unavailable", effect: "Glow X", match_name: "VENDOR Glow X" });
    // With no effect list to compare against, nothing is flagged.
    const none = host(proj, { effects: undefined });
    expect(none.A.preflightLayers({ comp_id: main.id }).issues).toEqual([]);
    expect(none.A.preflightLayers({ comp_id: main.id }).effects_check).toBe("unavailable");
  });

  it("flags a substituted font and collects text candidates", () => {
    const { proj, main } = scene();
    const t = main.layers.addText("Hello") as Any;
    const td = t.property("ADBE Text Properties").property("ADBE Text Document").staticValue as TextDocument & Any;
    td.font = "Brand-Bold";
    td.fontObject = { isSubstitute: true };
    const ok = main.layers.addText("Fine") as Any;
    ok.property("ADBE Text Properties").property("ADBE Text Document").staticValue.fontObject = { isSubstitute: false };
    const old = main.layers.addText("Old AE") as Any;
    void old; // no fontObject: before AE 24
    const { A } = host(proj);
    const r = A.preflightLayers({ comp_id: main.id, text_candidates: true });
    const fonts = r.issues.filter((i: Any) => i.type === "font_missing");
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatchObject({ layer: "Hello", kind: "text", detail: "Brand-Bold" });
    expect(r.fonts_unchecked).toBe(1);
    expect(r.texts.map((x: Any) => x.name)).toEqual(["Old AE", "Fine", "Hello"]);
    expect(A.preflightLayers({ comp_id: main.id }).texts).toEqual([]);
  });

  it("preflightLayers pages a comp and reports the nested comps it uses", () => {
    const { proj, main } = scene();
    const inner = proj.addComp("Inner", 100, 100, 1) as Any;
    for (let i = 0; i < 35; i++) main.layers.addNull();
    main.layers.add(inner);
    main.layers.add(inner);
    const { A } = host(proj);
    const first = A.preflightLayers({ comp_id: main.id, from: 1, limit: 30 });
    expect(first).toMatchObject({ num_layers: 37, from: 1, to: 30, next_from: 31 });
    expect(first.layers).toHaveLength(30);
    expect(first.layers[0].kind).toBe("precomp");
    expect(first.precomp_ids).toEqual([inner.id]);
    const second = A.preflightLayers({ comp_id: main.id, from: 31, limit: 30 });
    expect(second).toMatchObject({ to: 37, next_from: null });
    expect(second.precomp_ids).toEqual([]);
    expect(first.counts.precomp).toBe(2);
    expect(() => A.preflightLayers({ comp_id: 999999 })).toThrow(/No CompItem/);
  });
});

// ---------- glyph coverage, fix hints, 3D layer kinds ----------

describe("ae_preflight glyph findings and fix hints", () => {
  const glyphIssue = (layer: string, id: number, over: Partial<HostLayerIssue> = {}): HostLayerIssue => ({
    type: "glyphs_missing",
    index: id,
    layer_id: id,
    layer,
    kind: "text",
    detail: "Impact",
    font: "Impact",
    missing: ["\u015f", "\u011f"],
    suggested: ["ArialMT"],
    ...over,
  });

  it("groups missing glyphs per font into one warning with the characters and AE's default font", async () => {
    const issues = [glyphIssue("Title", 1), glyphIssue("Sub", 2, { missing: ["\u0131", "\u015f"] }), glyphIssue("Other", 3, { font: "Brand", detail: "Brand", missing: ["\u00fc"], suggested: [] })];
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["Title", "Sub", "Other"], issues }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    const hits = find(r, "glyphs_missing");
    expect(hits).toHaveLength(2);
    const impact = hits.find((f) => f.message.includes('"Impact"'))!;
    expect(impact.severity).toBe("warning");
    expect(impact.count).toBe(2);
    expect(impact.message).toContain("\u015f \u011f \u0131");
    expect(impact.message).toContain("Main > Title");
    expect(impact.message).toContain("ArialMT");
    expect(impact.fix).toMatchObject({ tool: "ae_fonts", args: { action: "check", fonts: ["Impact"], text: "\u015f\u011f\u0131" } });
    expect(impact.fix!.hint).toContain("ae_set_text");
    // A warning does not block the delivery gate.
    expect(r.findings.filter((f: Finding) => f.severity === "blocker")).toEqual([]);
  });

  it("says when glyph coverage could not be checked, and when it was checked only in part", async () => {
    const h = world({ comps: [{ info: comp(1, "Main"), layers: ["Title"] }] });
    const base = h.preflightLayers;
    h.preflightLayers = (a) => ({ ...(base(a) as LayersPage), glyphs_checked: 0, glyphs_unchecked: 3, glyphs_reason: "This After Effects cannot check glyph coverage (font.hasGlyphsFor needs 25.1)." });
    const skipped = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), fakeAe(h).ctx)) as any;
    expect(find(skipped, "glyphs_check_skipped")[0]).toMatchObject({ severity: "note", count: 3 });
    expect(find(skipped, "glyphs_check_skipped")[0].message).toContain("25.1");
    expect(skipped.checked.glyphs).toMatch(/not checked/);

    const h2 = world({ comps: [{ info: comp(1, "Main"), layers: ["Title"] }] });
    const base2 = h2.preflightLayers;
    h2.preflightLayers = (a) => ({ ...(base2(a) as LayersPage), glyphs_checked: 4, glyphs_whole_only: 1, glyphs_truncated: 2 });
    const partial = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), fakeAe(h2).ctx)) as any;
    expect(find(partial, "glyphs_check_partial")[0]).toMatchObject({ severity: "note", count: 3 });
    expect(find(partial, "glyphs_check_skipped")).toEqual([]);
    expect(partial.checked.glyphs).toContain("4 runs");
  });

  it("reports nothing about glyphs from a host that predates the check", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["Title"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    expect(codes(r).filter((c) => c.startsWith("glyphs_"))).toEqual([]);
  });

  it("points an unsaved project at ae_save with save_as", async () => {
    const { ctx } = fakeAe(world({ project: project({ saved: false, project_path: "<unsaved>", dirty: true }), comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const r = (await tool.handler(AePreflightSchema.parse({ naming: { allow_default_names: true } }), ctx)) as any;
    const f = find(r, "project_unsaved")[0];
    expect(f.fix).toMatchObject({ tool: "ae_save" });
    expect(f.fix!.hint).toContain("save_as: { path }");
    expect(f.fix!.hint).not.toContain("File > Save As");
  });

  it("points project setting differences at ae_project_settings with the argument it takes", async () => {
    const { ctx } = fakeAe(world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }] }));
    const r = (await tool.handler(
      AePreflightSchema.parse({
        naming: { allow_default_names: true },
        project_spec: { bits_per_channel: 16, working_space: "ACEScg", linear_blending: true, expression_engine: "extendscript" },
      }),
      ctx
    )) as any;
    const diffs = find(r, "project_setting_differs");
    expect(diffs).toHaveLength(4);
    const fixOf = (needle: string) => diffs.find((f) => f.message.includes(needle))!.fix!;
    expect(fixOf("Bit depth")).toMatchObject({ tool: "ae_project_settings", args: { set: { bits_per_channel: 16 }, expect: { project_path: "C:/Projects/Demo.aep" } } });
    expect(fixOf("Working colour space")).toMatchObject({ tool: "ae_project_settings", args: { set: { working_space: "ACEScg" } } });
    expect(fixOf("Expression engine")).toMatchObject({ tool: "ae_project_settings", args: { set: { expression_engine: "extendscript" } } });
    expect(fixOf("Linearize blending")).toMatchObject({ tool: "ae_project_settings", args: { set: { linear_blending: true } } });
    expect(fixOf("Bit depth").hint).toContain("set: { bits_per_channel: 16 }");
  });

  it("the description names the glyph check", () => {
    expect(tool.description).toContain("glyphs_missing");
  });
});

describe("preflight.jsx glyph coverage and layer kinds", () => {
  const TURKISH = "\u015eehir \u00e7ok g\u00fczel \u0131\u015f\u0131k";

  function glyphHost(opts: { withGlyphs?: boolean } = {}) {
    const withGlyphs = opts.withGlyphs !== false;
    const make = (ps: string, lacks: string, substitute = false) => {
      const f: Record<string, unknown> = { postScriptName: ps, familyName: ps, styleName: "Regular", isSubstitute: substitute };
      // Like a real font: no glyph for line breaks and other control characters.
      if (withGlyphs) f.hasGlyphsFor = (s: string) => !/[\r\n\t\u0003\u2028\u2029]/.test(s) && ![...s].some((c) => lacks.includes(c));
      return f;
    };
    const list = [make("ArialMT", ""), make("Impact", "\u015f\u011f\u0131\u0130")];
    const fonts = {
      getFontsByPostScriptName: (ps: string) => list.filter((f) => f.postScriptName === ps),
      getFontsByFamilyNameAndStyleName: () => [],
      allFonts: list.map((f) => [f]),
      missingOrSubstitutedFonts: [],
      getCTScriptForString: (s: string) => [{ chars: s, ctScript: 1 }],
      getDefaultFontForCTScript: () => list[0],
    };
    const proj = new FakeProject();
    const main = proj.addComp("Main", 1000, 500, 4) as Any;
    const loaded = loadHost(proj, ["preflight.jsx"], { effects: [{ matchName: "ADBE Fill" }], fonts });
    loaded.G.CTScript = { CT_ROMAN_SCRIPT: 1 };
    return { proj, main, ...loaded };
  }

  const textLayer = (main: Any, text: string, font: string, substitute = false) => {
    const t = main.layers.addText(text) as Any;
    const td = t.property("ADBE Text Properties").property("ADBE Text Document").staticValue as TextDocument & Any;
    td.text = text;
    td.font = font;
    td.fontObject = { isSubstitute: substitute };
    return { t, td };
  };

  it("flags the characters a text's font lacks, with AE's default font, and not a font that has them", () => {
    const { main, A, undo } = glyphHost();
    textLayer(main, TURKISH, "Impact");
    textLayer(main, TURKISH, "ArialMT");
    const r = A.preflightLayers({ comp_id: main.id });
    const hits = r.issues.filter((i: Any) => i.type === "glyphs_missing");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "text", font: "Impact", suggested: ["ArialMT"] });
    expect(hits[0].layer).toBe(TURKISH);
    expect(hits[0].missing).toEqual(expect.arrayContaining(["\u015f", "\u0131"]));
    expect(hits[0].missing).not.toContain("\u00e7");
    expect(r.glyphs_checked).toBe(2);
    expect(r.glyphs_unchecked).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("does not report line breaks inside a text layer as missing glyphs", () => {
    const { main, A } = glyphHost();
    textLayer(main, "Sehir\rok\nx", "ArialMT");
    textLayer(main, "\u015f\rok", "Impact");
    const r = A.preflightLayers({ comp_id: main.id });
    const hits = r.issues.filter((i: Any) => i.type === "glyphs_missing");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ font: "Impact", missing: ["\u015f"] });
  });

  it("checks each run of one font on its own in mixed-font text", () => {
    const { main, A } = glyphHost();
    const { td } = textLayer(main, "ab\u015fcd", "ArialMT");
    // Characters 2 and 3 are Impact: the \u015f falls in an Impact run.
    const fontAt = ["ArialMT", "ArialMT", "Impact", "Impact", "ArialMT"];
    (td as Any).characterRange = (s: number, e: number) => ({ text: td.text.substring(s, e), font: fontAt[s] });
    const r = A.preflightLayers({ comp_id: main.id });
    const hits = r.issues.filter((i: Any) => i.type === "glyphs_missing");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ font: "Impact", missing: ["\u015f"] });
    expect(r.glyphs_checked).toBe(3);
    expect(r.glyphs_whole_only).toBe(0);
    // The same text with the whole text in ArialMT would have passed: the run is what failed.
  });

  it("falls back to the whole text when it is too long to scan per character, and says so", () => {
    const { main, A } = glyphHost();
    const long = "\u015f".repeat(2000);
    const { td } = textLayer(main, long, "Impact");
    (td as Any).characterRange = (s: number, e: number) => ({ text: td.text.substring(s, e), font: "Impact" });
    const r = A.preflightLayers({ comp_id: main.id });
    expect(r.glyphs_whole_only).toBe(1);
    expect(r.issues.filter((i: Any) => i.type === "glyphs_missing")).toHaveLength(1);
  });

  it("does not check the glyphs of a substituted font (it is reported as missing already)", () => {
    const { main, A } = glyphHost();
    textLayer(main, TURKISH, "Brand-Bold", true);
    const r = A.preflightLayers({ comp_id: main.id });
    expect(r.issues.map((i: Any) => i.type)).toEqual(["font_missing"]);
    expect(r.glyphs_checked).toBe(0);
  });

  it("reports a font it cannot check (AE before 25.1) instead of guessing", () => {
    const { main, A } = glyphHost({ withGlyphs: false });
    textLayer(main, TURKISH, "Impact");
    const r = A.preflightLayers({ comp_id: main.id });
    expect(r.issues.filter((i: Any) => i.type === "glyphs_missing")).toEqual([]);
    expect(r.glyphs_checked).toBe(0);
    expect(r.glyphs_unchecked).toBe(1);
    expect(r.glyphs_reason).toMatch(/25\.1/);
  });

  it("classifies 3D model and parametric mesh layers, and leaves the old kinds alone", () => {
    const { proj, main, A } = glyphHost();
    main.stack.unshift(new FakeLayer(main, "Model", "ThreeDModelLayer"));
    main.stack.unshift(new FakeLayer(main, "Mesh", "ParametricMeshLayer"));
    main.layers.addText("Hello");
    main.layers.addCamera("Cam");
    main.layers.addSolid([1, 1, 1], "Solid", 100, 100, 1);
    void proj;
    const kinds = A.preflightLayers({ comp_id: main.id }).layers.map((l: Any) => [l.name, l.kind]);
    expect(kinds).toEqual([
      ["Solid", "solid"],
      ["Cam", "camera"],
      ["Hello", "text"],
      ["Mesh", "parametric_mesh"],
      ["Model", "model_3d"],
    ]);
  });
});

// ---------- image sequences ----------

describe("ae_preflight: missing frames in image sequences", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  const seqWorld = (opts: { skip?: number[]; ageS?: number; extra?: Partial<FootageInfo>; name?: string } = {}) => {
    const first = makeSequence(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-pfseq-")), { skip: opts.skip ?? [7, 8, 12] });
    tmpDirs.push(path.dirname(first));
    const old = useOldFiles(opts.ageS ?? 3600);
    restore = old.restore;
    const h = world({
      comps: [{ info: comp(1, "Main"), layers: ["BG"] }],
      footage: [footage(2, opts.name ?? "A_beauty.[0001-0020].exr", { file: first, used_in: [1], sequence: true, ae_frames: 20, ...opts.extra })],
    });
    return { h, first, old };
  };
  const run = (ctx: ToolContext, args: Record<string, unknown> = {}) => tool.handler(AePreflightSchema.parse({ comp_ids: [1], check_title_safe: false, ...args }), ctx) as Promise<any>;

  it("adds sequence_gaps (a warning, never a blocker) with the exact ranges", async () => {
    const { h } = seqWorld();
    const { ctx } = fakeAe(h);
    const r = await run(ctx);
    const f = find(r, "sequence_gaps");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    expect(f[0].message).toContain('"A_beauty.[0001-0020].exr": 3 frames missing between 1 and 20 (0007-0008, 0012)');
    expect(f[0].where).toMatchObject({ item_id: 2 });
    expect(f[0].fix?.tool).toBe("ae_replace_footage");
    expect(r.counts.blocker).toBe(0);
    expect(r.verdict).toBe("warnings");
  });

  it("reports a sequence still being written as writing, with the gaps flagged as maybe not there yet", async () => {
    const { h } = seqWorld({ ageS: 3 });
    const { ctx } = fakeAe(h);
    const r = await run(ctx);
    expect(codes(r)).not.toContain("sequence_gaps");
    const f = find(r, "sequence_writing");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    expect(f[0].message).toMatch(/still being written/);
    expect(f[0].message).toMatch(/3 frames below the highest written frame are not there yet.*out of order/);
    // no gaps and fresh: only a note
    restore?.();
    const clean = seqWorld({ ageS: 3, skip: [] });
    const r2 = await run(fakeAe(clean.h).ctx);
    expect(find(r2, "sequence_writing")[0].severity).toBe("note");
    expect(r2.counts.warning).toBe(0);
  });

  it("a footage file that is missing stays footage_missing and is not repeated as a sequence finding", async () => {
    const { h } = seqWorld({ extra: { missing: true } });
    const r = await run(fakeAe(h).ctx);
    expect(codes(r)).toContain("footage_missing");
    expect(codes(r).filter((c) => c.startsWith("sequence_"))).toEqual([]);
  });

  it("a sequence only comps outside the check use is left alone", async () => {
    const { h } = seqWorld({ extra: { used_in: [99] } });
    const r = await run(fakeAe(h).ctx);
    expect(codes(r).filter((c) => c.startsWith("sequence_"))).toEqual([]);
  });

  it("sequence_check off reads no folder", async () => {
    const { h, old } = seqWorld();
    const r = await run(fakeAe(h).ctx, { sequence_check: "off" });
    expect(codes(r)).not.toContain("sequence_gaps");
    expect(old.log.readdir).toEqual([]);
  });

  it("reads the folders after the queue lease is released", async () => {
    const { h } = seqWorld();
    const f = fakeAe(h);
    let held: boolean | null = null;
    const before = seqscanDeps.io;
    seqscanDeps.io = { ...before, readdir: async (d) => ((held = f.ctx.queue.inFlight !== null), nodeSeqIo.readdir(d)) };
    try {
      await run(f.ctx);
    } finally {
      seqscanDeps.io = before;
    }
    expect(held).toBe(false);
  });

  it("scope sequences lists only the footage: no project, no layer reads, rows with exact ranges", async () => {
    const { h } = seqWorld();
    const f = fakeAe(h);
    const r = await run(f.ctx, { scope: "sequences" });
    const fns = f.calls.map((c) => c.fn);
    expect(fns).not.toContain("preflightLayers");
    expect(fns).not.toContain("preflightProject");
    expect(fns).toContain("preflightItems");
    expect(r).toMatchObject({ ok: true, scope: "sequences", complete: true, sequence_footage: 1 });
    expect(r.sequences).toMatchObject({ checked: 1, with_gaps: 1 });
    expect(r.sequences.rows[0]).toMatchObject({ pattern: "A_beauty.[####].exr", first: 1, last: 20, on_disk: 17, missing: 3, missing_ranges: [[7, 8], [12, 12]], missing_text: "0007-0008, 0012", state: "gaps" });
    expect(r.scope_note).toMatch(/comp_ids and comp_names are not applied/);
  });

  it("scope sequences applies max_ranges and settle_s", async () => {
    const { h } = seqWorld({ skip: [3, 5, 7, 9], ageS: 40 });
    const r = await run(fakeAe(h).ctx, { scope: "sequences", max_ranges: 2, settle_s: 60 });
    const row = r.sequences.rows[0];
    expect(row.missing).toBe(4);
    expect(row.missing_ranges).toHaveLength(2);
    expect(row.ranges_truncated).toBe(true);
    expect(row.state).toBe("writing"); // 40 s old, settle_s 60
  });

  it("the gate carries the finding as a warning and still passes; sequence_check off skips it", async () => {
    const { h } = seqWorld();
    const gate = await runPreflightGate(fakeAe(h).ctx, { toolName: "ae_render_queue_add", opId: "op_s", comp_ids: [1] });
    expect(gate.blocked).toBe(false);
    expect(gate.summary.warnings.map((w) => w.code)).toContain("sequence_gaps");
    restore?.();
    const off = seqWorld();
    const gate2 = await runPreflightGate(fakeAe(off.h).ctx, { toolName: "ae_aerender_start", opId: "op_t", comp_ids: [1], sequence_check: "off" });
    expect(gate2.summary.warnings.map((w) => w.code)).not.toContain("sequence_gaps");
    expect(off.old.log.readdir).toEqual([]);
  });

  it("an unreadable folder is a warning and does not throw", async () => {
    const h = world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }], footage: [footage(2, "gone", { file: path.join(os.tmpdir(), "chroma-no-such-dir", "A.0001.exr"), used_in: [1], sequence: true })] });
    const r = await run(fakeAe(h).ctx);
    expect(find(r, "sequence_unreadable")[0]).toMatchObject({ severity: "warning" });
    expect(find(r, "sequence_unreadable")[0].message).toMatch(/folder not found/);
  });

  it("attachSequences never throws", async () => {
    const state = newScanState(normaliseOptions({}));
    state.footage = [footage(2, "x", { file: "C:/x/A.0001.exr", used_in: [1], sequence: true })];
    state.seen.add(1);
    const before = seqscanDeps.io;
    seqscanDeps.io = {
      ...before,
      readdir: async () => {
        throw new Error("EIO");
      },
    };
    try {
      await expect(attachSequences(state)).resolves.toBeUndefined();
    } finally {
      seqscanDeps.io = before;
    }
    expect(buildFindings(state).some((f) => f.code === "sequence_unreadable")).toBe(true);
  });
});

describe("preflight.jsx: image sequences", () => {
  type Any = any;
  it("preflightItems marks image sequences and gives AE's frame count; movies, stills and missing files stay out", () => {
    const proj = new FakeProject() as Any;
    proj.file = { fsName: "C:/Projects/Demo.aep" };
    const mk = (name: string, file: string, extra: Record<string, unknown> = {}, source: Any = new FileSource()) => {
      const f = proj.addFootage(name, 100, 100, source) as Any;
      f.file = { fsName: file };
      Object.assign(f, extra);
      return f;
    };
    mk("beauty", "C:/r/A_beauty.0001.exr", { duration: 4, frameRate: 25 });
    mk("plate", "C:/m/plate.mov", { duration: 4, frameRate: 25 });
    mk("logo", "C:/m/logo_01.png", { duration: 0, frameRate: 0 }, Object.assign(new FileSource(), { isStill: true }));
    mk("lost", "C:/r/B.0001.exr", { footageMissing: true, duration: 4, frameRate: 25 });
    mk("tiff", "C:/r/C_0001.tif", { duration: 0, frameRate: 0 });
    mk("numbered", "C:/r/D_0001.ext", { duration: 2, frameRate: 25 });
    const { A } = loadHost(proj, ["preflight.jsx"]);
    const byName = Object.fromEntries(A.preflightItems({ offset: 0, limit: 50 }).footage.map((f: Any) => [f.name, f]));
    expect(byName.beauty).toMatchObject({ sequence: true, ae_frames: 100 });
    expect(byName.plate.sequence).toBe(false);
    expect(byName.plate.ae_frames).toBeUndefined();
    expect(byName.logo.sequence).toBe(false);
    expect(byName.lost.sequence).toBeUndefined();
    expect(byName.tiff.sequence).toBe(true);
    expect(byName.tiff.ae_frames).toBeUndefined(); // zero duration: no guess
    expect(byName.numbered).toMatchObject({ sequence: true, ae_frames: 50 });
  });
});

// ---------- repair round ----------

describe("ae_preflight sequences: repair round", () => {
  let restore2: (() => void) | null = null;
  afterEach(() => {
    restore2?.();
    restore2 = null;
  });
  const oneSeq = (opts: { skip?: number[]; ageS?: number; extra?: Partial<FootageInfo> } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-pfseq2-"));
    tmpDirs.push(dir);
    const first = makeSequence(dir, { skip: opts.skip ?? [7] });
    const old = useOldFiles(opts.ageS ?? 3600);
    restore2 = old.restore;
    const h = world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }], footage: [footage(2, "plate", { file: first, used_in: [1], sequence: true, ...opts.extra })] });
    return { h, dir, first };
  };
  const go = (ctx: ToolContext, args: Record<string, unknown> = {}) => tool.handler(AePreflightSchema.parse({ comp_ids: [1], check_title_safe: false, ...args }), ctx) as Promise<any>;

  it("a folder a running aerender job is filling is writing, not gaps (liveDirs)", async () => {
    const { h, dir } = oneSeq();
    const before = seqscanDeps.liveDirs;
    seqscanDeps.liveDirs = () => [dir];
    try {
      const r = await go(fakeAe(h).ctx);
      expect(codes(r)).not.toContain("sequence_gaps");
      expect(find(r, "sequence_writing")[0].message).toMatch(/render started by this server/);
    } finally {
      seqscanDeps.liveDirs = before;
    }
    const plain = oneSeq();
    expect(codes(await go(fakeAe(plain.h).ctx))).toContain("sequence_gaps");
  });

  it("scope sequences with sequence_check off is refused, not answered with clean counts", async () => {
    const { h } = oneSeq();
    const f = fakeAe(h);
    const r = await go(f.ctx, { scope: "sequences", sequence_check: "off" });
    expect(r).toMatchObject({ ok: false, error: "sequence_check_off" });
    expect(f.calls).toEqual([]);
  });

  it("a stored sequences scan is dropped when another project is open", async () => {
    // 200 footage items: two item pages, so a one-slice call leaves a cursor.
    const items = Array.from({ length: 200 }, (_, i) => footage(100 + i, `f${i}.mov`, { file: `C:/media/f${i}.mov`, used_in: [1] }));
    const h = world({ comps: [{ info: comp(1, "Main"), layers: ["BG"] }], footage: items });
    let open = "C:/Projects/Demo.aep";
    h.status = () => ({ project_path: open });
    const f = fakeAe(h);
    const first = await go(f.ctx, { scope: "sequences", max_slices: 1 });
    expect(first.complete).toBe(false);
    open = "C:/Projects/Other.aep";
    const second = await tool.handler(AePreflightSchema.parse({ cursor: first.cursor }), f.ctx);
    expect(second).toMatchObject({ ok: false, error: "cursor_stale" });
    // the same project continues
    open = "C:/Projects/Demo.aep";
    const again = await go(f.ctx, { scope: "sequences", max_slices: 1 });
    const done = (await tool.handler(AePreflightSchema.parse({ cursor: again.cursor }), f.ctx)) as any;
    expect(done.ok).toBe(true);
  });

  it("new findings: sparse is a note, short and unknown are warnings, an unmatched name is a not-checked note", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-pfseq3-"));
    tmpDirs.push(dir);
    const every2 = makeSequence(path.join(dir, "a"), { prefix: "S.", from: 1, to: 40, skip: Array.from({ length: 20 }, (_, i) => i * 2 + 2) });
    const shortFirst = makeSequence(path.join(dir, "b"), { prefix: "T.", from: 1, to: 30 });
    const text = path.join(dir, "c", "shot_0001_beauty.exr");
    fs.mkdirSync(path.dirname(text), { recursive: true });
    fs.writeFileSync(text, "x");
    const old = useOldFiles();
    restore2 = old.restore;
    const h = world({
      comps: [{ info: comp(1, "Main"), layers: ["BG"] }],
      footage: [
        footage(2, "every2", { file: every2, used_in: [1], sequence: true, ae_frames: 20 }),
        footage(3, "shortone", { file: shortFirst, used_in: [1], sequence: true, ae_frames: 90 }),
        footage(4, "beauty", { file: text, used_in: [1], sequence: true }),
      ],
    });
    const r = await go(fakeAe(h).ctx);
    expect(find(r, "sequence_sparse")[0]).toMatchObject({ severity: "note" });
    expect(find(r, "sequence_short")[0]).toMatchObject({ severity: "warning", confidence: "low" });
    expect(find(r, "sequence_short")[0].message).toMatch(/counts about 90 frames but the folder holds 1-30/);
    expect(codes(r)).not.toContain("sequence_gaps");
    expect(find(r, "sequence_not_checked")[0]).toMatchObject({ severity: "note", count: 1 });
  });
});
