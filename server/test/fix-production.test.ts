/**
 * Regression tests for the production-group review fixes: shapes, Essential
 * Graphics, render templates, shot versioning and batch set.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeBatchSetSchema, AeSetEssentialGraphicsSchema, AeVersionFootageSchema, BatchOpSchema, batchMismatches, egpMismatches, productionTools } from "../src/tools/ext/production.js";
import { AeShapeSchema, shapeMismatches } from "../src/tools/ext/shapes.js";
import { appendVersionLog, planVersion, findVersions, versionLogPath } from "../src/versions.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function tree(files: string[]): string {
  const root = tempDir("chroma-fixprod-");
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  return root;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string, script: string) => unknown) {
  const calls: Array<{ fn: string; script: string }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-fixprod-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      return { ok: true, result: answer(fn, script), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}
const tool = (name: string) => productionTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const opacity = ["ADBE Transform Group", "ADBE Opacity"];

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  return { project, comp };
}

describe("ae_shape duplicate removal targets (C32)", () => {
  function layerWith(names: string[]) {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "shapes.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "shape", name: "Art", expect: GUARD });
    A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, add: names.map((n) => ({ type: "ellipse", name: n, size: [10, 10] })), expect: GUARD });
    const left = () => A.shapeContents({ comp_id: comp.id, layer: { name: "Art" } }).contents.map((c: any) => c.name);
    return { A, comp, left };
  }

  it("removes a content once when an index and a name both point at it", () => {
    const { A, comp, left } = layerWith(["A", "B", "C"]);
    const r = A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, remove: [{ index: 2 }, { name: "B" }], expect: GUARD });
    expect(r.removed).toEqual([{ index: 2, name: "B" }]);
    expect(left()).toEqual(["A", "C"]);
  });

  it("removes the last content once when named twice", () => {
    const { A, comp, left } = layerWith(["A", "B", "C"]);
    const r = A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, remove: [{ index: 3 }, { name: "C" }, { name: "C" }], expect: GUARD });
    expect(r.removed).toEqual([{ index: 3, name: "C" }]);
    expect(left()).toEqual(["A", "B"]);
  });
});

describe("ae_shape read-back past the cap (C81)", () => {
  it("does not pass groups it could not read back", () => {
    const adds = AeShapeSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [{ type: "ellipse", name: "Dot", size: [10, 10] }, { type: "ellipse", name: "Dot2", size: [10, 10] }], expect: expectArg }).add!;
    const contents = Array.from({ length: 200 }, (_v, i) => ({ index: i + 1, name: `g${i + 1}`, kind: "group", items: [] }));
    const after = { count: 202, truncated: true, contents };
    const m = shapeMismatches(adds, { count: 200, contents, truncated: true }, after, { added: [{ index: 201, name: "Dot" }, { index: 202, name: "Dot2" }], removed: [] });
    expect(m.map((x) => x.path)).toEqual(["contents[201]", "contents[202]"]);
    expect(m[0].message).toMatch(/not verified/);
  });

  it("still checks new groups that fall inside the cap", () => {
    const adds = AeShapeSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [{ type: "ellipse", name: "Dot", size: [10, 10] }], expect: expectArg }).add!;
    const contents = [{ index: 1, name: "Dot", kind: "group", items: [{ name: "E", kind: "ellipse", size: [99, 99] }] }];
    const m = shapeMismatches(adds, { count: 0, contents: [], truncated: false }, { count: 1, truncated: true, contents }, { added: [{ index: 1, name: "Dot" }], removed: [] });
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((x) => x.path.startsWith("Dot.size"))).toBe(true);
  });
});

describe("ae_version_footage host (C31, C74)", () => {
  it("swaps a sequence with numeric frame order, not forced alphabetical", () => {
    const project = new FakeProject();
    const seq = project.addFootage("seq", 1920, 1080);
    seq.file = { fsName: "C:/shots/seq_v001.0001.exr" };
    seq.mainSource.isStill = false;
    const seen: unknown[][] = [];
    const orig = seq.replaceWithSequence.bind(seq);
    seq.replaceWithSequence = (...a: unknown[]) => {
      seen.push(a.slice(1));
      return orig(a[0] as never);
    };
    const { A } = loadHost(project, ["production.jsx"]);
    A.versionFootage({ items: [{ item_id: seq.id, path: __filename, sequence: true }], expect: GUARD });
    expect(seen).toEqual([[false]]);
  });

  function projectWith(n: number) {
    const project = new FakeProject();
    for (let i = 0; i < n; i++) {
      const f = project.addFootage(`f${i}`, 10, 10);
      f.file = { fsName: `C:/f/f${i}_v001.mov` };
    }
    return loadHost(project, ["production.jsx"]).A;
  }

  it("flags truncation only when a 501st item is left out", () => {
    expect(projectWith(500).footageFiles({})).toMatchObject({ truncated: false });
    expect(projectWith(500).footageFiles({}).items).toHaveLength(500);
    const over = projectWith(501).footageFiles({});
    expect(over.items).toHaveLength(500);
    expect(over.truncated).toBe(true);
  });
});

describe("ae_version_footage tool (C74, C80)", () => {
  it("passes truncation through and lists unknown ids", async () => {
    const dir = tree(["a_v001.mov", "a_v002.mov"]);
    const { ctx } = fakeAe(() => ({
      project_path: "<unsaved>",
      truncated: true,
      items: [{ item_id: 1, name: "a", file: path.join(dir, "a_v001.mov"), sequence: false, missing: false, used_in: 1 }],
    }));
    const out = (await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({ item_ids: [1, 999] }), ctx)) as any;
    expect(out).toMatchObject({ ok: true, checked: 1, outdated: 1, truncated: true, missing_ids: [999] });
  });

  it("says not_found when no requested id is footage with a file", async () => {
    const { ctx } = fakeAe(() => ({ project_path: "<unsaved>", items: [] }));
    expect(await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({ item_ids: [999] }), ctx)).toMatchObject({ ok: false, error: "not_found", missing_ids: [999] });
    expect(await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({ item_ids: [999], version: 2 }), ctx)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("treats item_ids: [] as nothing requested, not not_found", async () => {
    const { ctx } = fakeAe(() => ({ project_path: "<unsaved>", items: [] }));
    expect(await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({ item_ids: [] }), ctx)).toMatchObject({ ok: true, checked: 0 });
  });

  it("reports an unreadable log set aside next to the new one", async () => {
    const dir = tree(["a_v001.mov", "a_v002.mov"]);
    const aep = path.join(dir, "Job.aep");
    fs.writeFileSync(versionLogPath(aep), '{"entries":[');
    const v1 = path.join(dir, "a_v001.mov");
    const v2 = path.join(dir, "a_v002.mov");
    let swapped = false;
    const { ctx } = fakeAe((fn) => {
      if (fn === "versionFootage") {
        swapped = true;
        return { replaced: [] };
      }
      return { project_path: aep, items: [{ item_id: 1, name: "a", file: swapped ? v2 : v1, sequence: false, missing: false, used_in: 1 }] };
    });
    const out = (await tool("ae_version_footage").handler(AeVersionFootageSchema.parse({ update: true, expect: expectArg }), ctx)) as any;
    expect(out.log_path).toBe(versionLogPath(aep));
    expect(out.log_aside).toMatch(/\.bak$/);
    expect(fs.readFileSync(out.log_aside, "utf8")).toBe('{"entries":[');
  });
});

describe("versions.ts (C34, C82, C83)", () => {
  it("does not call an older version newer when the current file is not on disk", () => {
    const root = tree(["a_v1.mov", "a_v2.mov", "a_v3.mov", "a_v4.mov"]);
    const p = planVersion(path.join(root, "a_v5.mov"), false);
    expect(p).toMatchObject({ current: 5, latest: 4, newer: false });
    // An explicit version is still a rollback request.
    expect(planVersion(path.join(root, "a_v5.mov"), false, 2).newer).toBe(true);
    expect(planVersion(path.join(root, "a_v2.mov"), false).newer).toBe(true);
  });

  it("versions a sequence by its file name when the folder's token belongs to something else", () => {
    const root = tree(["show_v2/shot010_v003.0001.exr", "show_v2/shot010_v004.0001.exr", "show_v3/other.0001.exr"]);
    const r = findVersions(path.join(root, "show_v2", "shot010_v003.0001.exr"), true);
    expect(r.current).toBe(3);
    expect(r.versions.map((v) => v.version)).toEqual([3, 4]);
  });

  it("keeps the folder as the version when the file has none, or the same one", () => {
    const root = tree(["v003/plate.0001.exr", "v004/plate.0001.exr"]);
    expect(findVersions(path.join(root, "v003", "plate.0001.exr"), true).versions.map((v) => v.version)).toEqual([3, 4]);
    const root2 = tree(["shot_v001/shot_v001.0001.exr", "shot_v002/shot_v002.0001.exr"]);
    expect(findVersions(path.join(root2, "shot_v001", "shot_v001.0001.exr"), true).versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("sets an unparsable log aside instead of overwriting it", () => {
    const root = tree([]);
    const aep = path.join(root, "Job.aep");
    const log = versionLogPath(aep);
    fs.writeFileSync(log, '{"entries":[{"item_id":1');
    const notes: { aside?: string } = {};
    const entry = { at: "t", item_id: 2, name: "n", from: "a", to: "b", from_version: 1, to_version: 2 };
    appendVersionLog(aep, [entry], notes);
    expect(notes.aside).toBeDefined();
    expect(fs.readFileSync(notes.aside!, "utf8")).toBe('{"entries":[{"item_id":1');
    expect(JSON.parse(fs.readFileSync(log, "utf8")).entries).toEqual([entry]);
    expect(fs.readdirSync(root).some((f) => f.endsWith(".tmp"))).toBe(false);
    // A readable log is appended to and nothing is set aside.
    const again: { aside?: string } = {};
    appendVersionLog(aep, [entry], again);
    expect(again.aside).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(log, "utf8")).entries).toHaveLength(2);
  });

  it("sets aside a log that is JSON but has no entries list", () => {
    const root = tree([]);
    const aep = path.join(root, "Job.aep");
    fs.writeFileSync(versionLogPath(aep), '{"hello":1}');
    const notes: { aside?: string } = {};
    appendVersionLog(aep, [], notes);
    expect(notes.aside).toBeDefined();
  });

  it("throws, leaving the log alone, when it can't be read at all", () => {
    const root = tree([]);
    const aep = path.join(root, "Job.aep");
    fs.mkdirSync(versionLogPath(aep)); // reading a directory fails with EISDIR
    expect(() => appendVersionLog(aep, [])).toThrow();
    expect(fs.statSync(versionLogPath(aep)).isDirectory()).toBe(true);
  });
});

describe("ae_render_templates (C79)", () => {
  it("answers from an existing item without a guard or a checkpoint, even with allow_temp", async () => {
    const { ctx, calls } = fakeAe(() => ({ source: "existing_item", render_settings: ["Best Settings"], output_modules: ["Lossless"] }));
    const out = await tool("ae_render_templates").handler({ allow_temp: true }, ctx);
    expect(out).toMatchObject({ source: "existing_item" });
    expect(calls.map((c) => c.fn)).toEqual(["renderTemplates"]);
  });

  it("with an empty queue and allow_temp but no expect, still refuses", async () => {
    const { ctx } = fakeAe(() => ({ source: "none", needs_item: true, render_settings: [], output_modules: [] }));
    expect(await tool("ae_render_templates").handler({ allow_temp: true }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
  });
});

describe("boolean overrides and batch values (C76)", () => {
  it("accepts a checkbox override that reads back as 1", () => {
    const args = AeSetEssentialGraphicsSchema.parse({ comp_id: 1, action: "set_override", layer: { index: 1 }, name: "Show", value: true, expect: expectArg });
    const read = (value: unknown) => ({ template_name: null, controllers: [], overrides: [{ index: 1, name: "Show", value }] });
    expect(egpMismatches(args, read(0), read(1))).toEqual([]);
    expect(egpMismatches(args, read(1), read(true))).toEqual([]);
    expect(egpMismatches(args, read(1), read(0))).toHaveLength(1);
  });

  it("accepts boolean batch values and keyframes that read back as 0 or 1", () => {
    const ops = AeBatchSetSchema.parse({
      comp_id: 1,
      ops: [
        { layer: { index: 1 }, path: ["ADBE Effect Parade", "Check"], value: false },
        { layer: { index: 2 }, path: ["ADBE Effect Parade", "Check"], keyframes: [{ time: 0, value: true }] },
      ],
      expect: expectArg,
    }).ops;
    const after = { time: 0, results: [{ op: 1, numKeys: 0, value: 0 }, { op: 2, numKeys: 1, keys: [{ time: 0, value: 1 }] }] };
    expect(batchMismatches(ops, after, 0)).toEqual([]);
  });
});

describe("batch ops that share a property (C78)", () => {
  it("checks only the last value written to a property in a chunk", () => {
    const ops = AeBatchSetSchema.parse({
      comp_id: 1,
      ops: [
        { layer: { index: 1 }, path: opacity, value: 0 },
        { layer: { index: 1 }, path: opacity, value: 100 },
        { layer: { index: 2 }, path: opacity, expression: "1" },
        { layer: { index: 2 }, path: opacity, expression: "2" },
      ],
      expect: expectArg,
    }).ops;
    const after = { time: 0, results: [{ op: 1, numKeys: 0, value: 100 }, { op: 2, numKeys: 0, value: 100 }, { op: 3, numKeys: 0, value: 2, expression: "2" }, { op: 4, numKeys: 0, value: 2, expression: "2" }] };
    expect(batchMismatches(ops, after, 0)).toEqual([]);
    // The last write is still checked.
    after.results[1].value = 50;
    expect(batchMismatches(ops, after, 0).map((m) => m.path)).toEqual(["ops[2].value"]);
  });
});

describe("batch expression followed by keyframes (C78)", () => {
  it("still checks the earlier expression", () => {
    const ops = AeBatchSetSchema.parse({
      comp_id: 1,
      ops: [
        { layer: { index: 1 }, path: opacity, expression: "wiggle(2,20)" },
        { layer: { index: 1 }, path: opacity, keyframes: [{ time: 0, value: 0 }] },
      ],
      expect: expectArg,
    }).ops;
    const keys = [{ time: 0, value: 0 }];
    const good = { time: 0, results: [{ op: 1, numKeys: 1, expression: "wiggle(2,20)", keys }, { op: 2, numKeys: 1, expression: "wiggle(2,20)", keys }] };
    expect(batchMismatches(ops, good, 0)).toEqual([]);
    const bad = { time: 0, results: [{ op: 1, numKeys: 1, expression: "", keys }, { op: 2, numKeys: 1, expression: "", keys }] };
    expect(batchMismatches(ops, bad, 0).map((m) => m.path)).toEqual(["ops[1].expression"]);
  });
});

describe("BatchOpSchema (C77)", () => {
  const base = { layer: { index: 1 }, path: opacity };
  it("rejects a null value and a keyframe without a value", () => {
    expect(BatchOpSchema.safeParse({ ...base, value: null }).success).toBe(false);
    expect(BatchOpSchema.safeParse({ ...base, value: null, expression: "1" }).success).toBe(false);
    expect(BatchOpSchema.safeParse({ ...base, keyframes: [{ time: 1 }] }).success).toBe(false);
    expect(BatchOpSchema.safeParse({ ...base, keyframes: [{ time: 1, value: null }] }).success).toBe(false);
    expect(BatchOpSchema.safeParse({ ...base, keyframes: [{ time: 1, value: 0 }] }).success).toBe(true);
    expect(BatchOpSchema.safeParse({ ...base, value: 0 }).success).toBe(true);
  });
});

describe("ae_batch_set checks every chunk before writing (C33)", () => {
  const ops = [1, 2, 3, 4, 5].map((i) => ({ layer: { index: i }, path: opacity, value: i }));

  it("writes nothing when a later chunk has a bad op", async () => {
    const { ctx, calls } = fakeAe((fn, script) => {
      if (fn === "batchValidate") {
        const a = JSON.parse(script.slice(script.indexOf("(") + 1, -1));
        return a.base === 2 ? { ok: false, error: "Op 3: No layer at index 3" } : { ok: true, checked: a.ops.length };
      }
      return { done: 0 };
    });
    const out = (await tool("ae_batch_set").handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: expectArg }), ctx)) as any;
    expect(out).toMatchObject({ ok: false, error: "bad_args", applied: false, done: 0 });
    expect(out.message).toMatch(/Op 3/);
    expect(calls.map((c) => c.fn)).toEqual(["batchValidate", "batchValidate"]);
  });

  it("checks all chunks, then writes them with their offsets", async () => {
    const { ctx, calls } = fakeAe((fn, script) => {
      const a = JSON.parse(script.slice(script.indexOf("(") + 1, -1));
      if (fn === "batchValidate") return { ok: true, checked: a.ops.length };
      if (fn === "batchSet") return { done: a.ops.length };
      return { time: 0, results: a.ops.map((o: any, i: number) => ({ op: i + 1, numKeys: 0, value: o.layer.index })) };
    });
    const out = (await tool("ae_batch_set").handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: expectArg }), ctx)) as any;
    expect(out).toMatchObject({ ok: true, done: 5, matches: true });
    const order = calls.map((c) => c.fn).filter((f) => f === "batchValidate" || f === "batchSet");
    expect(order).toEqual(["batchValidate", "batchValidate", "batchValidate", "batchSet", "batchSet", "batchSet"]);
    const bases = calls.filter((c) => c.fn === "batchSet").map((c) => JSON.parse(c.script.slice(c.script.indexOf("(") + 1, -1)).base);
    expect(bases).toEqual([0, 2, 4]);
  });
});

describe("batchValidate host (C33)", () => {
  function setup() {
    const { project, comp } = scene();
    const { A, undo } = loadHost(project, ["layers.jsx", "production.jsx"]);
    for (const n of ["A", "B"]) A.createLayer({ comp_id: comp.id, type: "solid", name: n, expect: GUARD });
    return { A, comp, undo };
  }

  it("reports the first bad op by its place in the whole batch and changes nothing", () => {
    const { A, comp, undo } = setup();
    const begun = undo.begun;
    const r = A.batchValidate({ comp_id: comp.id, base: 500, ops: [{ layer: { name: "A" }, path: opacity, value: 1 }, { layer: { name: "Z" }, path: opacity, value: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Op 502: No layer named "Z"/);
    expect(undo.begun).toBe(begun);
    expect(comp.layer("A")!.transform("ADBE Opacity").value).toBe(100);
  });

  it("flags a group path, and passes good ops", () => {
    const { A, comp } = setup();
    expect(A.batchValidate({ comp_id: comp.id, ops: [{ layer: { name: "A" }, path: ["ADBE Transform Group"], value: 1 }] })).toMatchObject({ ok: false });
    expect(A.batchValidate({ comp_id: comp.id, ops: [{ layer: { name: "A" }, path: opacity, value: 1 }] })).toEqual({ ok: true, checked: 1 });
  });
});
