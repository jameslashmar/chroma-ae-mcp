/**
 * Wave 5 "props" group: the opt-in extras of ae_get_layer_full, model_3d / parametric_mesh in ae_find_layers,
 * ae_validate_expressions fix, ae_purge_unused consolidate / reduce, Essential Graphics media replacement,
 * ae_render_templates save, and ae_batch_set with paths, markers and expression errors.
 * Schemas, the guarded-write flow over a fake bridge, the pure checks, and the host functions under node:vm.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { multicompTools } from "../src/tools/ext/multicomp.js";
import { getSessionTracker, installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import {
  AeGetLayerFullSchema,
  AeValidateExpressionsSchema,
  brokenWith,
  exploreTools,
  FIX_SCOPE_NOTE,
  fixMismatches,
  fixReport,
  type ExpressionScan,
} from "../src/tools/ext/explore.js";
import {
  AePurgeUnusedSchema,
  consolidateMismatches,
  layoutTools,
  reduceMismatches,
} from "../src/tools/ext/layout.js";
import {
  AeBatchSetSchema,
  AeRenderTemplatesSchema,
  AeSetEssentialGraphicsSchema,
  BatchOpSchema,
  batchMismatches,
  egpMismatches,
  flattenOverrides,
  markerValueMismatches,
  productionTools,
  saveTemplateMismatches,
  shapeValueMismatches,
} from "../src/tools/ext/production.js";
import { FakeFootage, FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, PropertyValueType, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  resetSessionTracking();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeAe(answer: (fn: string, args: any) => unknown) {
  const calls: Array<{ fn: string; args: any }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tempDir("chroma-w5-q-"), "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, -1) || "{}");
      calls.push({ fn, args });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      return { ok: true, result: answer(fn, args), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls, fns: () => calls.map((c) => c.fn) };
}

const tool = (name: string) => [...exploreTools, ...layoutTools, ...productionTools].find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };
const opacity = ["ADBE Transform Group", "ADBE Opacity"];

/** The message and kind a host function threw (an Error from the vm realm). */
function thrown(fn: () => unknown): { message: string; kind?: string } {
  try {
    fn();
  } catch (e: any) {
    return { message: String(e.message), kind: e.__kind };
  }
  throw new Error("expected the host function to throw");
}

// =====================================================================
// Schemas
// =====================================================================

describe("schemas", () => {
  it("ae_get_layer_full keeps its defaults and adds the opt-in extras", () => {
    const plain = AeGetLayerFullSchema.parse({ comp_id: 1, layer: { index: 1 } });
    expect(plain).toEqual({ comp_id: 1, layer: { index: 1 }, max_keyframes: 100, shape_depth: 4 });
    const full = AeGetLayerFullSchema.parse({
      comp_id: 1,
      layer: { index: 1 },
      meta: true,
      text_full: true,
      bounds: { time: 2, points_to_comp: [[1, 2]], points_to_layer: [[3, 4]] },
    });
    expect(full.meta).toBe(true);
    expect(full.bounds?.points_to_comp).toEqual([[1, 2]]);
    expect(AeGetLayerFullSchema.safeParse({ comp_id: 1, layer: { index: 1 }, bounds: { points_to_comp: [[1]] } }).success).toBe(false);
    expect(AeGetLayerFullSchema.safeParse({ comp_id: 1, layer: { index: 1 }, bounds: { points_to_comp: Array(101).fill([0, 0]) } }).success).toBe(false);
  });

  it("ae_validate_expressions takes fix, and apply needs fix and expect", () => {
    expect(AeValidateExpressionsSchema.parse({ comp_id: 12 })).toEqual({ comp_id: 12 });
    expect(AeValidateExpressionsSchema.safeParse({ comp_id: 1, fix: { find: "a", replace: "b" } }).success).toBe(true);
    expect(AeValidateExpressionsSchema.safeParse({ comp_id: 1, fix: { find: "", replace: "b" } }).success).toBe(false);
    expect(AeValidateExpressionsSchema.safeParse({ comp_id: 1, apply: true, expect: expectArg }).success).toBe(false);
    expect(AeValidateExpressionsSchema.safeParse({ comp_id: 1, fix: { find: "a", replace: "b" }, apply: true }).success).toBe(false);
    expect(AeValidateExpressionsSchema.safeParse({ comp_id: 1, fix: { find: "a", replace: "" }, apply: true, expect: expectArg }).success).toBe(true);
  });

  it("ae_purge_unused takes consolidate or reduce_to_comp_ids, not both and not with the plain options", () => {
    expect(AePurgeUnusedSchema.safeParse({}).success).toBe(true);
    expect(AePurgeUnusedSchema.safeParse({ kinds: ["footage"], empty_folders: true }).success).toBe(true);
    expect(AePurgeUnusedSchema.safeParse({ consolidate: true }).success).toBe(true);
    expect(AePurgeUnusedSchema.safeParse({ reduce_to_comp_ids: [3] }).success).toBe(true);
    expect(AePurgeUnusedSchema.safeParse({ reduce_to_comp_ids: [] }).success).toBe(false);
    expect(AePurgeUnusedSchema.safeParse({ consolidate: true, reduce_to_comp_ids: [3] }).success).toBe(false);
    expect(AePurgeUnusedSchema.safeParse({ consolidate: true, keep: [1] }).success).toBe(false);
    expect(AePurgeUnusedSchema.safeParse({ reduce_to_comp_ids: [3], kinds: ["solid"] }).success).toBe(false);
  });

  it("ae_set_essential_graphics takes set_media with an item and add without a path", () => {
    const base = { comp_id: 1, expect: expectArg };
    expect(AeSetEssentialGraphicsSchema.safeParse({ ...base, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: 5 }).success).toBe(true);
    expect(AeSetEssentialGraphicsSchema.safeParse({ ...base, action: "set_media", layer: { index: 1 }, name: "Logo" }).success).toBe(false);
    expect(AeSetEssentialGraphicsSchema.safeParse({ ...base, action: "add", layer: { index: 1 } }).success).toBe(true);
    expect(AeSetEssentialGraphicsSchema.safeParse({ ...base, action: "add" }).success).toBe(false);
  });

  it("ae_render_templates save needs the item, the kind, a real name and expect", () => {
    const save = { action: "save", kind: "render_settings", item_index: 1, item_comp_id: 7, name: "Mine", expect: expectArg };
    expect(AeRenderTemplatesSchema.safeParse({}).success).toBe(true);
    expect(AeRenderTemplatesSchema.safeParse(save).success).toBe(true);
    expect(AeRenderTemplatesSchema.safeParse({ ...save, name: "   " }).success).toBe(false);
    expect(AeRenderTemplatesSchema.safeParse({ ...save, expect: undefined }).success).toBe(false);
    expect(AeRenderTemplatesSchema.safeParse({ ...save, item_comp_id: undefined }).success).toBe(false);
    expect(AeRenderTemplatesSchema.safeParse({ ...save, kind: "output_module" }).success).toBe(false);
    expect(AeRenderTemplatesSchema.safeParse({ ...save, kind: "output_module", om_index: 1 }).success).toBe(true);
  });

  it("batch ops accept expression_enabled alone, still refuse null and empty ops", () => {
    expect(BatchOpSchema.safeParse({ layer: { index: 1 }, path: opacity, expression_enabled: false }).success).toBe(true);
    expect(BatchOpSchema.safeParse({ layer: { index: 1 }, path: opacity }).success).toBe(false);
    expect(BatchOpSchema.safeParse({ layer: { index: 1 }, path: opacity, value: null }).success).toBe(false);
    expect(BatchOpSchema.safeParse({ layer: { index: 1 }, path: ["ADBE Marker"], keyframes: [{ time: 1, value: { comment: "Hi" } }] }).success).toBe(true);
  });
});

// =====================================================================
// Pure checks
// =====================================================================

describe("expression fix report", () => {
  const entry = (id: number, name: string, error: string, contains: boolean) => ({
    layer: { index: id, id, name },
    path: ["Transform", "Opacity"],
    expression: "layer(\"Old\").opacity",
    expressionEnabled: false,
    error,
    contains_find: contains,
  });
  const scan = (results: ReturnType<typeof entry>[]): ExpressionScan => ({ comp_id: 1, total_expressions: results.length, error_count: results.filter((r) => r.error).length, truncated: false, results });
  const fix = { find: "Old", replace: "New" };

  it("lists only the broken expressions whose whole text contains the find text", () => {
    const s = scan([entry(1, "a", "err", true), entry(2, "b", "", true), entry(3, "c", "err", false)]);
    expect(brokenWith(s).map((e) => e.layer.id)).toEqual([1]);
    expect(brokenWith(null)).toEqual([]);
  });

  it("reports fixed and still broken, and flags the ones left in the receipt", () => {
    const before = scan([entry(1, "a", "err", true), entry(2, "b", "err", true)]);
    const after = scan([entry(1, "a", "", false), entry(2, "b", "other error", false)]);
    const report = fixReport(fix, before, after, { matched_before: 2 });
    expect(report).toMatchObject({ scope: "project", fixed_count: 1, still_broken_count: 1, matched_in_project: 2, scope_note: FIX_SCOPE_NOTE });
    expect((report.still_broken as Array<{ layer: { id: number } }>)[0].layer.id).toBe(2);
    const m = fixMismatches(fix, before, after, {});
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe("expressions.still_broken");
    expect(fixMismatches(fix, before, scan([entry(1, "a", "", false), entry(2, "b", "", false)]), {})).toEqual([]);
    expect(fixMismatches(fix, before, after, { no_op: true })).toEqual([]);
  });
});

describe("consolidate and reduce checks", () => {
  it("consolidateMismatches checks the item count; groups the plan's own key still sees are not a mismatch", () => {
    const plan = (n: number, groups: number) => ({ numItems: n, footage_with_file: 3, group_total: groups, removable: groups, groups: [] });
    expect(consolidateMismatches(plan(10, 1), plan(9, 0), { removed: 1 })).toEqual([]);
    expect(consolidateMismatches(plan(10, 1), plan(9, 1), { removed: 1 })).toEqual([]);
    expect(consolidateMismatches(plan(10, 1), plan(9, 0), { removed: 3 }).map((x) => x.path)).toEqual(["numItems"]);
    expect(consolidateMismatches(plan(10, 1), plan(10, 0), { no_op: true })).toEqual([]);
  });

  it("reduceMismatches wants nothing unreached and every kept comp still there", () => {
    const plan = (remove: number, keep: number[]) => ({ numItems: 4, keep_comps: keep.map((id) => ({ id, name: `c${id}` })), kept_items: 2, remove: [], remove_total: remove, folders_total: 0 });
    expect(reduceMismatches([3], plan(0, [3]), { removed: 2 })).toEqual([]);
    expect(reduceMismatches([3], plan(2, [3]), {}).map((x) => x.path)).toEqual(["unreached_items"]);
    expect(reduceMismatches([3, 4], plan(0, [3]), {}).map((x) => x.path)).toEqual(["keep_comps[4]"]);
  });
});

describe("batch read-back checks", () => {
  const ops = (list: unknown[]) => AeBatchSetSchema.parse({ comp_id: 1, ops: list, expect: expectArg }).ops;

  it("reports a broken expression instead of calling it applied", () => {
    const o = ops([{ layer: { index: 1 }, path: opacity, expression: "bad" }]);
    const ok = { time: 0, results: [{ op: 1, numKeys: 0, value: 1, expression: "bad", expression_enabled: true }] };
    expect(batchMismatches(o, ok, 0)).toEqual([]);
    const broken = { time: 0, results: [{ op: 1, numKeys: 0, value: 1, expression: "bad", expression_enabled: false, expression_error: "bad is not defined" }] };
    const m = batchMismatches(o, broken, 0);
    expect(m.map((x) => x.path)).toEqual(["ops[1].expression_error"]);
  });

  it("does not call a switched-off broken expression a mismatch", () => {
    const off = ops([{ layer: { index: 1 }, path: opacity, expression_enabled: false }]);
    const read = { time: 0, results: [{ op: 1, numKeys: 0, expression: "bad", expression_enabled: false, expression_error: "bad is not defined" }] };
    expect(batchMismatches(off, read, 0)).toEqual([]);
    expect(batchMismatches(off, { time: 0, results: [{ op: 1, numKeys: 0, expression_enabled: true, expression_error: "x" }] }, 0).map((x) => x.path)).toEqual(["ops[1].expression_enabled"]);
    const on = ops([{ layer: { index: 1 }, path: opacity, expression_enabled: true }]);
    expect(batchMismatches(on, { time: 0, results: [{ op: 1, numKeys: 0, expression_enabled: false, expression_error: "bad" }] }, 0).map((x) => x.path)).toEqual(["ops[1].expression_error"]);
  });

  it("recognises a marker written as a string or with only chapter / url", () => {
    const str = ops([{ layer: { index: 1 }, path: ["ADBE Marker"], keyframes: [{ time: 1, value: "Beat" }] }]);
    const read = (v: unknown) => ({ time: 0, results: [{ op: 1, numKeys: 1, keys: [{ time: 1, value: v }] }] });
    expect(batchMismatches(str, read({ comment: "Beat", duration: 0 }), 0)).toEqual([]);
    expect(batchMismatches(str, read({ comment: "Other", duration: 0 }), 0).map((x) => x.path)).toEqual(["ops[1].keys@1.comment"]);
    const ch = ops([{ layer: { index: 1 }, path: ["ADBE Marker"], keyframes: [{ time: 1, value: { chapter: "Intro", url: "http://x" } }] }]);
    expect(batchMismatches(ch, read({ comment: "", chapter: "Intro", url: "http://x" }), 0)).toEqual([]);
    expect(batchMismatches(ch, read({ comment: "", chapter: "Outro", url: "http://x" }), 0).map((x) => x.path)).toEqual(["ops[1].keys@1.chapter"]);
  });

  it("checks expression_enabled on its own", () => {
    const o = ops([{ layer: { index: 1 }, path: opacity, expression_enabled: false }]);
    expect(batchMismatches(o, { time: 0, results: [{ op: 1, numKeys: 0, expression: "x", expression_enabled: false }] }, 0)).toEqual([]);
    expect(batchMismatches(o, { time: 0, results: [{ op: 1, numKeys: 0, expression: "x", expression_enabled: true }] }, 0).map((x) => x.path)).toEqual(["ops[1].expression_enabled"]);
  });

  it("compares a written path with the shape the read-back serialised", () => {
    const want = { vertices: [[0, 0], [10, 0], [10, 10]], closed: true };
    const o = ops([{ layer: { index: 1 }, path: ["ADBE Mask Parade", 1, "ADBE Mask Shape"], value: want }]);
    const got = { vertices: [[0, 0], [10, 0], [10, 10]], inTangents: [[0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0]], closed: true, num_vertices: 3 };
    expect(batchMismatches(o, { time: 0, results: [{ op: 1, numKeys: 0, value: got }] }, 0)).toEqual([]);
    expect(batchMismatches(o, { time: 0, results: [{ op: 1, numKeys: 0, value: { ...got, vertices: [[0, 0], [10, 0], [10, 11]] } }] }, 0)).toHaveLength(1);
    expect(batchMismatches(o, { time: 0, results: [{ op: 1, numKeys: 0, value: "[Shape]" }] }, 0)).toHaveLength(1);
  });

  it("shapeValueMismatches covers count, tangents and the closed flag", () => {
    const got = { vertices: [[0, 0], [5, 5]], inTangents: [[0, 0], [1, 1]], outTangents: [[0, 0], [2, 2]], closed: false, num_vertices: 2 };
    expect(shapeValueMismatches({ vertices: [[0, 0], [5, 5]], inTangents: [[0, 0], [1, 1]], closed: false }, got, "p")).toEqual([]);
    expect(shapeValueMismatches({ vertices: [[0, 0]] }, got, "p")[0].path).toBe("p.vertices.length");
    expect(shapeValueMismatches({ vertices: [[0, 0], [5, 5]], outTangents: [[0, 0], [3, 3]] }, got, "p")[0].path).toBe("p.outTangents[1]");
    expect(shapeValueMismatches({ vertices: [[0, 0], [5, 5]], closed: true }, got, "p")[0].path).toBe("p.closed");
  });

  it("checks a marker key's comment and duration", () => {
    const o = ops([{ layer: { index: 1 }, path: ["ADBE Marker"], keyframes: [{ time: 1, value: { comment: "Beat", duration: 0.5 } }] }]);
    const read = (comment: string, duration: number) => ({ time: 0, results: [{ op: 1, numKeys: 1, keys: [{ time: 1, value: { comment, duration } }] }] });
    expect(batchMismatches(o, read("Beat", 0.5), 0)).toEqual([]);
    expect(batchMismatches(o, read("Other", 0.5), 0).map((x) => x.path)).toEqual(["ops[1].keys@1.comment"]);
    expect(markerValueMismatches({ duration: 2 }, { comment: "", duration: 1 }, "k").map((x) => x.path)).toEqual(["k.duration"]);
  });
});

describe("Essential Graphics and render template checks", () => {
  it("flattens override groups and checks a media slot's source", () => {
    const tree = [{ index: 1, name: "Colors", kind: "group" as const, children: [{ index: 1, name: "Logo", alternate_source_id: 9 }] }];
    expect(flattenOverrides(tree).map((o) => o.name)).toEqual(["Colors", "Logo"]);
    const args = AeSetEssentialGraphicsSchema.parse({ comp_id: 1, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: 9, expect: expectArg });
    const state = (id: number) => ({ template_name: null, controllers: [], overrides: [{ index: 1, name: "Colors", kind: "group" as const, children: [{ index: 1, name: "Logo", alternate_source_id: id }] }] });
    expect(egpMismatches(args, state(1), state(9))).toEqual([]);
    expect(egpMismatches(args, state(9), state(1)).map((m) => m.path)).toEqual(["overrides.Logo.alternate_source_id"]);
  });

  it("saveTemplateMismatches wants the name in the list afterwards", () => {
    const args = AeRenderTemplatesSchema.parse({ action: "save", kind: "render_settings", item_index: 1, item_comp_id: 7, name: "Mine", expect: expectArg });
    const list = (names: string[], truncated = false) => ({ item: { index: 1, comp_id: 7, comp_name: "A", status: null }, kind: "render_settings", templates: names, count: names.length, truncated });
    expect(saveTemplateMismatches(args, list(["Best Settings"]), list(["Best Settings", "mine"]), { replaced: false })).toEqual([]);
    expect(saveTemplateMismatches(args, list(["Best Settings"]), list(["Best Settings"]), {})).toHaveLength(1);
    // A list cut at 500 names can hide the new one: no false alarm.
    expect(saveTemplateMismatches(args, list([]), list(["Best Settings"], true), {})).toEqual([]);
  });
});

// =====================================================================
// Guarded flows over a fake bridge
// =====================================================================

describe("ae_validate_expressions fix", () => {
  const scan = (error: string, contains = true) => ({
    comp_id: 1,
    comp_name: "Main",
    time: 0,
    total_expressions: 1,
    error_count: error ? 1 : 0,
    truncated: false,
    find_matches: error && contains ? 1 : 0,
    results: [{ layer: { index: 1, id: 10, name: "A" }, path: ["Transform", "Opacity"], expression: "layer(\"Old\")", expressionEnabled: false, error, contains_find: contains }],
  });

  it("without fix it is the same single read as before", async () => {
    const { ctx, calls } = fakeAe(() => scan(""));
    await tool("ae_validate_expressions").handler({ comp_id: 1 }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ comp_id: 1 });
  });

  it("a dry run lists what would be fixed and writes nothing", async () => {
    const { ctx, calls, fns } = fakeAe(() => scan("Old is not defined"));
    const out: any = await tool("ae_validate_expressions").handler({ comp_id: 1, fix: { find: "Old", replace: "New" } }, ctx);
    expect(fns()).toEqual(["validateExpressions"]);
    expect(calls[0].args.find).toBe("Old");
    expect(out).toMatchObject({ dry_run: true, would_fix_count: 1 });
    expect(out.scope_note).toContain("whole project");
  });

  it("apply goes through the guarded write, validates again and says fixed / still broken", async () => {
    let fixed = false;
    const { ctx, fns } = fakeAe((fn) => {
      if (fn === "exploreAutoFixExpressions") {
        fixed = true;
        return { matched_before: 3, broken_before: 3, comps_scanned: 2, scope: "project" };
      }
      return fixed ? scan("") : scan("Old is not defined");
    });
    const out: any = await tool("ae_validate_expressions").handler({ comp_id: 1, fix: { find: "Old", replace: "New" }, apply: true, expect: expectArg }, ctx);
    expect(fns()).toEqual(["checkGuard", "validateExpressions", "exploreAutoFixExpressions", "validateExpressions"]);
    expect(out).toMatchObject({ applied: true, scope: "project", fixed_count: 1, still_broken_count: 0, matched_in_project: 3 });
    expect(out.receipt.matches).toBe(true);
  });

  it("puts a repair that left errors behind into the receipt, not into a throw", async () => {
    const { ctx } = fakeAe((fn) => (fn === "exploreAutoFixExpressions" ? { matched_before: 1 } : scan("Old is not defined")));
    const out: any = await tool("ae_validate_expressions").handler({ comp_id: 1, fix: { find: "Old", replace: "New" }, apply: true, expect: expectArg }, ctx);
    expect(out).toMatchObject({ applied: true, fixed_count: 0, still_broken_count: 1 });
    expect(out.receipt.matches).toBe(false);
  });

  it("apply without expect is refused before anything runs", async () => {
    const { ctx, calls } = fakeAe(() => scan(""));
    expect(await tool("ae_validate_expressions").handler({ comp_id: 1, fix: { find: "a", replace: "b" }, apply: true }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toHaveLength(0);
  });
});

describe("ae_purge_unused consolidate and reduce", () => {
  const plan = (groups: number, numItems = 10) => ({ numItems, footage_with_file: 4, group_total: groups, removable: groups, groups: groups ? [{ file: "C:/a.mov", count: 2, items: [{ id: 1, name: "a", used_in: 1 }, { id: 2, name: "a 2", used_in: 0 }] }] : [] });

  it("consolidate: the dry run lists groups and notes that AE's rule is its own", async () => {
    const { ctx, fns } = fakeAe(() => plan(1));
    const out: any = await tool("ae_purge_unused").handler({ consolidate: true }, ctx);
    expect(fns()).toEqual(["exploreConsolidatePlan"]);
    expect(out).toMatchObject({ ok: true, dry_run: true, mode: "consolidate", group_count: 1 });
    expect(out.rule_note).toContain("undocumented");
  });

  it("consolidate: apply reports AE's count next to the plan and checks no groups remain", async () => {
    let done = false;
    const { ctx, fns } = fakeAe((fn) => {
      if (fn === "exploreConsolidateFootage") {
        done = true;
        return { removed: 1, planned_groups: 1, planned_removals: 1, numItems: 9 };
      }
      return done ? plan(0, 9) : plan(1, 10);
    });
    const out: any = await tool("ae_purge_unused").handler({ consolidate: true, apply: true, expect: expectArg }, ctx);
    expect(fns()).toEqual(["exploreConsolidatePlan", "checkGuard", "exploreConsolidatePlan", "exploreConsolidateFootage", "exploreConsolidatePlan"]);
    expect(out).toMatchObject({ applied: true, mode: "consolidate", removed: 1, groups_left: 0, numItems: 9 });
    expect(out.receipt.matches).toBe(true);
    expect(out.count_note).toBeUndefined();
  });

  it("consolidate: a returned count that differs from the plan is stated, not hidden", async () => {
    let done = false;
    const { ctx } = fakeAe((fn) => {
      if (fn === "exploreConsolidateFootage") {
        done = true;
        return { removed: 3 };
      }
      return done ? plan(0, 7) : plan(1, 10);
    });
    const out: any = await tool("ae_purge_unused").handler({ consolidate: true, apply: true, expect: expectArg }, ctx);
    expect(out.count_note).toContain("3");
    expect(out.receipt.matches).toBe(true);
  });

  it("consolidate: nothing to merge means no write", async () => {
    const { ctx, fns } = fakeAe(() => plan(0));
    const out: any = await tool("ae_purge_unused").handler({ consolidate: true, apply: true, expect: expectArg }, ctx);
    expect(fns()).toEqual(["exploreConsolidatePlan"]);
    expect(out).toMatchObject({ ok: true, group_count: 0 });
  });

  const reduce = (remove: number, keep = [3]) => ({ numItems: 6, keep_comps: keep.map((id) => ({ id, name: `c${id}` })), kept_items: 2, remove: Array.from({ length: remove }, (_, i) => ({ id: 20 + i, name: `x${i}`, kind: "footage" })), remove_total: remove, folders_total: 1 });

  it("reduce: the dry run lists what the kept comps do not reach", async () => {
    const { ctx, calls } = fakeAe(() => reduce(2));
    const out: any = await tool("ae_purge_unused").handler({ reduce_to_comp_ids: [3] }, ctx);
    expect(calls[0]).toMatchObject({ fn: "exploreReducePlan", args: { comp_ids: [3] } });
    expect(out).toMatchObject({ dry_run: true, mode: "reduce", remove_count: 2, kept_items: 2 });
    expect(out.rule_note).toContain("not followed");
  });

  it("reduce: apply runs reduceProject through the guarded write and checks the plan is empty afterwards", async () => {
    let done = false;
    const { ctx, fns, calls } = fakeAe((fn) => {
      if (fn === "exploreReduceProject") {
        done = true;
        return { removed: 2, planned_removals: 2, numItems: 4 };
      }
      return done ? reduce(0) : reduce(2);
    });
    const out: any = await tool("ae_purge_unused").handler({ reduce_to_comp_ids: [3], apply: true, expect: expectArg }, ctx);
    expect(fns()).toEqual(["exploreReducePlan", "checkGuard", "exploreReducePlan", "exploreReduceProject", "exploreReducePlan"]);
    expect(calls.find((c) => c.fn === "exploreReduceProject")!.args).toMatchObject({ comp_ids: [3] });
    expect(out).toMatchObject({ applied: true, mode: "reduce", removed: 2 });
    expect(out.receipt.matches).toBe(true);
  });

  it("reduce: leftovers after the write are a mismatch, not an error", async () => {
    const { ctx } = fakeAe((fn) => (fn === "exploreReduceProject" ? { removed: 1 } : reduce(2)));
    const out: any = await tool("ae_purge_unused").handler({ reduce_to_comp_ids: [3], apply: true, expect: expectArg }, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
  });
});

describe("ae_set_essential_graphics set_media", () => {
  it("sends item_id and reads the slot's media back", async () => {
    let done = false;
    const state = () => ({ template_name: "T", controllers: [], overrides: [{ index: 1, name: "Logo", alternate_source_id: done ? 9 : 4 }] });
    const { ctx, calls } = fakeAe((fn) => {
      if (fn === "egpEdit") {
        done = true;
        return { action: "set_media" };
      }
      return state();
    });
    const out: any = await tool("ae_set_essential_graphics").handler(
      AeSetEssentialGraphicsSchema.parse({ comp_id: 1, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: 9, expect: expectArg }),
      ctx
    );
    expect(calls.find((c) => c.fn === "egpEdit")!.args).toMatchObject({ action: "set_media", item_id: 9, name: "Logo" });
    expect(calls.find((c) => c.fn === "egpRead")!.args.layer).toEqual({ index: 1 });
    expect(out.receipt.matches).toBe(true);
  });
});

describe("wave 5 props fixes", () => {
  it("ae_render_templates save says it is not undoable; ae_purge_unused scopes 'never removed' to the default mode", () => {
    const d = tool("ae_render_templates").description;
    expect(d).toContain("NOT undoable");
    expect(d).not.toContain("in one undo group");
    expect(d).not.toContain("ae_undo");
    expect(d).toContain("Ctrl+Z");
    expect(tool("ae_purge_unused").description).toContain("In the default mode comps are never removed");
  });

  it("consolidate: leftover groups are reported as information, not as a failed receipt", async () => {
    const group = { file: "C:/a.mov", count: 2, items: [{ id: 1, name: "a", used_in: 1 }, { id: 2, name: "a 2", used_in: 0 }] };
    const plan = (groups: number, numItems: number) => ({ numItems, footage_with_file: 4, group_total: groups, removable: groups, groups: groups ? [group] : [] });
    let done = false;
    const { ctx } = fakeAe((fn) => {
      if (fn === "exploreConsolidateFootage") {
        done = true;
        return { removed: 1 };
      }
      return done ? plan(1, 9) : plan(2, 10);
    });
    const out: any = await tool("ae_purge_unused").handler({ consolidate: true, apply: true, expect: expectArg }, ctx);
    expect(out.groups_left).toBe(1);
    expect(out.groups_left_note).toContain("not an error");
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_batch_set with a { text, font } write and allow_substitute reads back as a match", async () => {
    const textDoc = ["ADBE Text Properties", "ADBE Text Document"];
    const { ctx } = fakeAe((fn) => (fn === "batchSet" ? { done: 1 } : fn === "batchValidate" ? { ok: true } : { time: 0, results: [{ op: 1, numKeys: 0, value: { text: "x" }, expression: "" }] }));
    const ops = [{ layer: { index: 1 }, path: textDoc, value: { text: "x", font: "Nope-Regular" } }];
    const out: any = await tool("ae_batch_set").handler(AeBatchSetSchema.parse({ comp_id: 1, ops, allow_substitute: true, expect: expectArg }), ctx);
    expect(out.matches).toBe(true);
    expect(out.mismatches).toEqual([]);
    // A wrong text is still caught.
    expect(batchMismatches([{ layer: { index: 1 }, path: textDoc, value: { text: "y", font: "Nope-Regular" } }] as any, { time: 0, results: [{ op: 1, numKeys: 0, value: { text: "x" } }] }, 0).length).toBeGreaterThan(0);
  });

  it("ae_batch_set passes allow_substitute to the check and the write", async () => {
    const { ctx, calls } = fakeAe((fn) => (fn === "batchSet" ? { done: 1 } : fn === "batchValidate" ? { ok: true } : { time: 0, results: [{ op: 1, numKeys: 0, value: 5, expression: "" }] }));
    const ops = [{ layer: { index: 1 }, path: opacity, value: 5 }];
    await tool("ae_batch_set").handler(AeBatchSetSchema.parse({ comp_id: 1, ops, allow_substitute: true, expect: expectArg }), ctx);
    expect(calls.find((c) => c.fn === "batchValidate")!.args.allow_substitute).toBe(true);
    expect(calls.find((c) => c.fn === "batchSet")!.args.allow_substitute).toBe(true);
  });
});

describe("wave 5 props leftovers", () => {
  it("ae_batch_set says only the text of a Source Text value is read back", () => {
    const d = tool("ae_batch_set").description;
    expect(d).toContain("only the text is compared");
    expect(d).toContain("font and other style keys are not read back");
  });

  it("ae_multi_comp_apply dry run forwards allow_substitute to batchValidate", async () => {
    const multi = multicompTools.find((t) => t.name === "ae_multi_comp_apply")!;
    const answer = (fn: string, a: any) => {
      if (fn === "multicompResolve") return { comps: [{ id: 1, name: "A" }], matched: 1, missing_ids: [], truncated: false, partial: false };
      if (fn === "multicompProbe") return { comps: [{ id: 1, exists: true, name: "A", found: {"Title": 1} }], truncated: false };
      if (fn === "batchValidate") return { ok: true };
      return {};
    };
    const textDoc = ["ADBE Text Properties", "ADBE Text Document"];
    const batch = fakeAe(answer);
    await multi.handler(
      multi.schema.parse({ op: { tool: "ae_batch_set", args: { ops: [{ layer: { name: "Title" }, path: textDoc, value: { text: "x", font: "Nope-Regular" } }], allow_substitute: true } }, comp_ids: [1], dry_run: true, expect: expectArg }),
      batch.ctx
    );
    expect(batch.calls.find((c) => c.fn === "batchValidate")!.args.allow_substitute).toBe(true);
    const prop = fakeAe(answer);
    await multi.handler(
      multi.schema.parse({ op: { tool: "ae_set_property", args: { layer: { name: "Title" }, path: textDoc, value: { text: "x", font: "Nope-Regular" }, allow_substitute: true } }, comp_ids: [1], dry_run: true, expect: expectArg }),
      prop.ctx
    );
    expect(prop.calls.find((c) => c.fn === "batchValidate")!.args.allow_substitute).toBe(true);
    const plain = fakeAe(answer);
    await multi.handler(
      multi.schema.parse({ op: { tool: "ae_batch_set", args: { ops: [{ layer: { name: "Title" }, path: opacity, value: 5 }] } }, comp_ids: [1], dry_run: true, expect: expectArg }),
      plain.ctx
    );
    expect(plain.calls.find((c) => c.fn === "batchValidate")!.args.allow_substitute).toBe(false);
    // The first call loads the whole tool registry: over 5 s when the suite runs in parallel.
  }, 20_000);
});

describe("ae_render_templates save and the session log", () => {
  it("is logged as an agent write but adds no undo step to ae_session_changes", async () => {
    const dir = tempDir("chroma-w5-s-");
    let saved = false;
    const snapshot = {
      project_path: "<unsaved>", dirty: true, revision: 10, num_items: 1, item_ids: [1], items_truncated: false,
      active_item: null, ae_version: "26.2.1", build: "100", render_queue: { num_items: 1, queued: 1, rendering: 0 }, comps: [],
    };
    const { ctx } = fakeAe((fn) => {
      if (fn === "sessionSnapshot") return snapshot;
      if (fn === "exploreSaveTemplate") {
        saved = true;
        return { saved: "Mine", replaced: false };
      }
      return { item: { index: 1, comp_id: 7, comp_name: "A", status: "QUEUED" }, kind: "render_settings", templates: saved ? ["Mine"] : [], count: saved ? 1 : 0, truncated: false };
    });
    const t = installSessionTracking({ dataDir: dir, quarantine: ctx.quarantine });
    expect(getSessionTracker()).toBe(t);
    const start = new Date(Date.now() - 1000).toISOString();
    const out: any = await tool("ae_render_templates").handler(
      AeRenderTemplatesSchema.parse({ action: "save", kind: "render_settings", item_index: 1, item_comp_id: 7, name: "Mine", expect: expectArg }),
      ctx
    );
    expect(out.applied).toBe(true);
    expect(t.steps()).toEqual([]);
    expect(t.agentWritesSince("<unsaved>", start).map((w) => w.tool)).toEqual(["ae_render_templates"]);
  });
});

describe("ae_render_templates save", () => {
  const save = { action: "save", kind: "render_settings", item_index: 1, item_comp_id: 7, name: "Mine", expect: expectArg };
  const list = (names: string[]) => ({ item: { index: 1, comp_id: 7, comp_name: "A", status: "QUEUED" }, kind: "render_settings", templates: names, count: names.length, truncated: false });

  it("saves through the guarded write and reads the list back in a separate call", async () => {
    let saved = false;
    const { ctx, fns, calls } = fakeAe((fn) => {
      if (fn === "exploreSaveTemplate") {
        saved = true;
        return { saved: "Mine", replaced: false };
      }
      return list(saved ? ["Best Settings", "Mine"] : ["Best Settings"]);
    });
    const out: any = await tool("ae_render_templates").handler(save, ctx);
    expect(fns()).toEqual(["checkGuard", "exploreRqTemplates", "exploreSaveTemplate", "exploreRqTemplates"]);
    expect(calls[2].args).toMatchObject({ kind: "render_settings", item_index: 1, item_comp_id: 7, name: "Mine" });
    expect(out).toMatchObject({ applied: true, saved: "Mine", replaced: false });
    expect(out.templates).toContain("Mine");
    expect(out.note).toContain("machine-wide");
    expect(out.receipt.matches).toBe(true);
  });

  it("flags a name that is not in the list after saving", async () => {
    const { ctx } = fakeAe((fn) => (fn === "exploreSaveTemplate" ? { saved: "Mine", replaced: false } : list(["Best Settings"])));
    const out: any = await tool("ae_render_templates").handler(save, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
  });

  it("refuses without expect, a blank name, or an output_module without om_index, before any call", async () => {
    const { ctx, calls } = fakeAe(() => list([]));
    expect(await tool("ae_render_templates").handler({ ...save, expect: undefined }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(await tool("ae_render_templates").handler({ ...save, name: "  " }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(await tool("ae_render_templates").handler({ ...save, kind: "output_module" }, ctx)).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toHaveLength(0);
  });
});

describe("ae_batch_set with paths, markers and expression errors", () => {
  it("asks the read-back to evaluate only the ops that wrote an expression", async () => {
    const reads: any[] = [];
    const { ctx } = fakeAe((fn, args) => {
      if (fn === "batchValidate") return { ok: true };
      if (fn === "batchSet") return { done: args.ops.length };
      reads.push(args.ops);
      return { time: 0, results: args.ops.map((_: unknown, i: number) => ({ op: i + 1, numKeys: 0, value: 50, expression: i === 1 ? "bad" : "", expression_error: i === 1 ? "bad is not defined" : undefined })) };
    });
    const out: any = await tool("ae_batch_set").handler(
      AeBatchSetSchema.parse({ comp_id: 1, ops: [{ layer: { index: 1 }, path: opacity, value: 50 }, { layer: { index: 2 }, path: opacity, expression: "bad" }], expect: expectArg }),
      ctx
    );
    expect(reads[0][0].check_expression).toBeUndefined();
    expect(reads[0][1].check_expression).toBe(true);
    expect(out).toMatchObject({ ok: true, applied: true, matches: false });
    expect(out.mismatches[0].path).toBe("ops[2].expression_error");
  });
});

// =====================================================================
// Host functions under node:vm
// =====================================================================

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  return { project, comp };
}

describe("explore.jsx: ae_get_layer_full extras", () => {
  function textScene() {
    const { project, comp } = scene();
    const layer = comp.layers.addText("Hello");
    const { A } = loadHost(project, ["explore.jsx"]);
    return { A, comp, layer: layer as FakeLayer, project };
  }

  it("is unchanged without the opt-ins", () => {
    const { A, comp } = textScene();
    const r = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 } });
    expect(r.bounds).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    const opacityProp = r.transform.properties.find((p: any) => p.matchName === "ADBE Opacity");
    expect(opacityProp.meta).toBeUndefined();
    expect(r.text.sourceText.value.mixed).toBeUndefined();
  });

  it("meta adds what a property accepts and a fresh expression error, and leaves the state alone", () => {
    const { A, comp, layer } = textScene();
    const op = layer.transform("ADBE Opacity") as any;
    op.hasMin = true;
    op.minValue = 0;
    op.hasMax = true;
    op.maxValue = 100;
    op.expression = "foo";
    op.expressionEnabled = true;
    let evaluated = 0;
    op.valueAtTime = function (this: any, _t: number, pre: boolean) {
      evaluated++;
      expect(pre).toBe(false);
      this.expressionError = "foo is not defined";
      return 1;
    };
    const plain = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["transform"] });
    expect(plain.transform.properties.find((p: any) => p.matchName === "ADBE Opacity").expressionError).toBeUndefined();
    expect(evaluated).toBe(0);
    const r = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["transform"], meta: true });
    const p = r.transform.properties.find((x: any) => x.matchName === "ADBE Opacity");
    expect(p.expressionError).toBe("foo is not defined");
    expect(p.expressionEnabled).toBe(true);
    expect(p.meta).toMatchObject({ value_type: "OneD", min: 0, max: 100, can_expression: true });
    expect(evaluated).toBe(1);
    expect(op.expressionEnabled).toBe(true);
    // The opt-in does not stay on for the next call.
    const again = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["transform"] });
    expect(again.transform.properties.find((x: any) => x.matchName === "ADBE Opacity").meta).toBeUndefined();
  });

  it("meta serialises a Shape through the core helper, with its vertex count", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addShape() as FakeLayer;
    const root = layer.property("ADBE Root Vectors Group") as FakeGroup;
    root.addProperty("ADBE Vector Shape - Group");
    const { A, G } = loadHost(project, ["explore.jsx"]);
    const pathProp = ((root.property(1) as FakeGroup).property("ADBE Vector Shape") as FakeProperty) as any;
    const shape = new G.Shape();
    shape.vertices = [[0, 0], [10, 0], [10, 10]];
    shape.inTangents = [[0, 0], [0, 0], [0, 0]];
    shape.outTangents = [[0, 0], [0, 0], [0, 0]];
    pathProp.staticValue = shape;
    const find = (r: any) => r.shapes.properties[0].properties[0].value;
    const plain = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["shapes"] });
    expect(find(plain).num_vertices).toBeUndefined();
    const meta = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["shapes"], meta: true });
    expect(find(meta)).toMatchObject({ num_vertices: 3, closed: true });
    expect(find(meta).vertices).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("text_full adds the whole document beside the fields that are always there", () => {
    const { A, comp } = textScene();
    const plain = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["text"] });
    expect(plain.text.sourceText.value.fontFamily).toBeUndefined();
    const full = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: ["text"], text_full: true });
    const v = full.text.sourceText.value;
    expect(v.text).toBe("Hello");
    expect(v.fontSize).toBe(72);
    expect(Array.isArray(v.mixed)).toBe(true);
  });

  it("bounds reads the rectangle, the comp-space corners and the point conversions", () => {
    const { A, comp, layer } = textScene();
    const shifted = comp.layers.addSolid([1, 1, 1], "Plate", 100, 100, 1) as FakeLayer;
    (shifted as any).sourcePointToComp = (pt: number[]) => [pt[0] + 10, pt[1] + 20];
    (shifted as any).compPointToSource = (pt: number[]) => [pt[0] - 10, pt[1] - 20];
    void layer;
    const r = A.getLayerFull({ comp_id: comp.id, layer: { id: shifted.id }, include: [], bounds: { points_to_comp: [[0, 0], [5, 5]], points_to_layer: [[10, 20]] } });
    expect(r.bounds.rect).toEqual({ left: 0, top: 0, width: 100, height: 100 });
    expect(r.bounds.corners_comp).toEqual([[10, 20], [110, 20], [110, 120], [10, 120]]);
    expect(r.bounds.points_to_comp).toEqual([[10, 20], [15, 25]]);
    expect(r.bounds.points_to_layer).toEqual([[0, 0]]);
    expect(r.bounds.conversion_time).toBe(0);
    expect(r.bounds.warnings).toEqual([]);
  });

  it("bounds warns when the time differs, on text layers, and when the conversion methods are missing", () => {
    const { A, comp, layer } = textScene();
    (layer as any).sourcePointToComp = (pt: number[]) => [pt[0], pt[1]];
    const r = A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: [], bounds: { time: 2 } });
    expect(r.bounds.time).toBe(2);
    expect(r.bounds.warnings.join(" ")).toContain("current time");
    expect(r.bounds.warnings.join(" ")).toContain("first character");
    const { A: A2, comp: comp2 } = textScene();
    const none = A2.getLayerFull({ comp_id: comp2.id, layer: { index: 1 }, include: [], bounds: {} });
    expect(none.bounds.corners_comp).toBeUndefined();
    expect(none.bounds.warnings.join(" ")).toContain("sourcePointToComp");
    expect(none.bounds.rect).toBeDefined();
  });

  it("bounds does not move the comp's time", () => {
    const { A, comp } = textScene();
    comp.time = 1.5;
    A.getLayerFull({ comp_id: comp.id, layer: { index: 1 }, include: [], bounds: { time: 3 } });
    expect(comp.time).toBe(1.5);
  });
});

describe("explore.jsx: model_3d and parametric_mesh layers", () => {
  it("classifies them and ae_find_layers filters by them", () => {
    const { project, comp } = scene();
    comp.layers.addSolid([1, 1, 1], "Plate", 100, 100, 1);
    const model = new FakeLayer(comp, "Model", "ThreeDModelLayer");
    const mesh = new FakeLayer(comp, "Mesh", "ParametricMeshLayer");
    comp.stack.unshift(model, mesh);
    const { A } = loadHost(project, ["explore.jsx"]);
    const models = A.findLayers({ comp_id: comp.id, type: "model_3d" });
    expect(models.matches.map((m: any) => m.layer.name)).toEqual(["Model"]);
    expect(models.matches[0].layer.kind).toBe("model_3d");
    expect(A.findLayers({ comp_id: comp.id, type: "parametric_mesh" }).matches.map((m: any) => m.layer.name)).toEqual(["Mesh"]);
    expect(A.findLayers({ comp_id: comp.id, type: "ThreeDModelLayer" }).total_matched).toBe(1);
    expect(A.findLayers({ comp_id: comp.id, type: "solid" }).total_matched).toBe(1);
  });
});

describe("explore.jsx: validateExpressions find and exploreAutoFixExpressions", () => {
  function brokenScene() {
    const { project, comp } = scene();
    const a = comp.layers.addSolid([1, 1, 1], "A", 100, 100, 1) as FakeLayer;
    const b = comp.layers.addSolid([1, 1, 1], "B", 100, 100, 1) as FakeLayer;
    const breakIt = (layer: FakeLayer, expr: string) => {
      const p = layer.transform("ADBE Opacity") as any;
      p.expression = expr;
      p.expressionEnabled = false;
      p.expressionError = "broken";
      p.valueAtTime = () => {
        throw new Error("broken");
      };
    };
    breakIt(a, "layer(\"Old\").opacity");
    breakIt(b, "layer(\"Other\").opacity");
    const calls: Array<[string, string]> = [];
    (project as any).autoFixExpressions = (f: string, r: string) => calls.push([f, r]);
    const { A, undo } = loadHost(project, ["explore.jsx"]);
    return { A, comp, project, calls, undo };
  }

  it("validateExpressions is unchanged without find, and flags matches on the whole expression with it", () => {
    const { A, comp } = brokenScene();
    const plain = A.validateExpressions({ comp_id: comp.id });
    expect(plain.results[0].contains_find).toBeUndefined();
    expect(plain.find_matches).toBeUndefined();
    const withFind = A.validateExpressions({ comp_id: comp.id, find: "Old" });
    expect(withFind.error_count).toBe(2);
    expect(withFind.find_matches).toBe(1);
    expect(withFind.results.map((r: any) => r.contains_find)).toEqual([false, true]);
  });

  it("rewrites project-wide inside one undo group", () => {
    const { A, comp, calls, undo } = brokenScene();
    const r = A.exploreAutoFixExpressions({ find: "Old", replace: "New", expect: GUARD });
    expect(calls).toEqual([["Old", "New"]]);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    expect(r).toMatchObject({ matched_before: 1, broken_before: 2, scope: "project" });
    expect(r.note).toContain("whole project");
    void comp;
  });

  it("changes nothing, with no undo group, when no broken expression has the text", () => {
    const { A, calls, undo } = brokenScene();
    const r = A.exploreAutoFixExpressions({ find: "Nowhere", replace: "x", expect: GUARD });
    expect(r).toMatchObject({ no_op: true, matched_before: 0 });
    expect(calls).toEqual([]);
    expect(undo.begun).toBe(0);
  });

  it("refuses a bad guard, an empty find and an AE without autoFixExpressions, before any undo group", () => {
    const { A, project, calls, undo } = brokenScene();
    expect(thrown(() => A.exploreAutoFixExpressions({ find: "Old", replace: "x", expect: { project_path: "C:/other.aep" } })).kind).toBe("guard");
    expect(thrown(() => A.exploreAutoFixExpressions({ find: "", replace: "x", expect: GUARD })).message).toContain("non-empty");
    expect(thrown(() => A.exploreAutoFixExpressions({ find: "Old", expect: GUARD })).message).toContain("replace");
    delete (project as any).autoFixExpressions;
    expect(thrown(() => A.exploreAutoFixExpressions({ find: "Old", replace: "x", expect: GUARD })).message).toContain("no Project.autoFixExpressions");
    expect(calls).toEqual([]);
    expect(undo.begun).toBe(0);
  });
});

describe("layout.jsx: consolidate and reduce", () => {
  function footageScene() {
    const { project, comp } = scene();
    const mk = (name: string, file: string) => {
      const f = project.addFootage(name, 100, 100) as FakeFootage;
      f.file = { fsName: file };
      return f;
    };
    const a1 = mk("a.mov", "C:\\shots\\a.mov");
    const a2 = mk("a.mov 2", "c:/shots/A.MOV");
    const b = mk("b.mov", "C:/shots/b.mov");
    const solid = project.addFootage("Solid", 100, 100, Object.assign(new (loadHost(project, []).G.SolidSource)(), {})) as FakeFootage;
    comp.layers.add(a1);
    comp.layers.add(b);
    return { project, comp, a1, a2, b, solid };
  }

  it("lists footage that shares a file (any slash, any case) and skips solids", () => {
    const { project, a1, a2 } = footageScene();
    const { A } = loadHost(project, ["layout.jsx"]);
    const plan = A.exploreConsolidatePlan();
    expect(plan.group_total).toBe(1);
    expect(plan.removable).toBe(1);
    expect(plan.groups[0].items.map((i: any) => i.id)).toEqual([a1.id, a2.id]);
    expect(plan.groups[0].items[0].used_in).toBe(1);
  });

  it("an interpretation difference keeps two files in separate groups", () => {
    const { project, a2 } = footageScene();
    (a2.mainSource as any).alphaMode = "STRAIGHT";
    const { A } = loadHost(project, ["layout.jsx"]);
    expect(A.exploreConsolidatePlan().group_total).toBe(0);
  });

  it("a different pixel aspect, or still versus sequence, keeps same-file items apart", () => {
    const par = footageScene();
    (par.a2 as any).pixelAspect = 2;
    expect(loadHost(par.project, ["layout.jsx"]).A.exploreConsolidatePlan().group_total).toBe(0);
    const seq = footageScene();
    (seq.a2.mainSource as any).isStill = !(seq.a1.mainSource as any).isStill;
    expect(loadHost(seq.project, ["layout.jsx"]).A.exploreConsolidatePlan().group_total).toBe(0);
  });

  it("consolidates once, in one undo group, and reports the count AE returned", () => {
    const { project, a2 } = footageScene();
    let called = 0;
    (project as any).consolidateFootage = () => {
      called++;
      project.all = project.all.filter((x) => x !== a2);
      return 1;
    };
    const { A, undo } = loadHost(project, ["layout.jsx"]);
    const r = A.exploreConsolidateFootage({ expect: GUARD });
    expect(called).toBe(1);
    expect(undo.begun).toBe(1);
    expect(r).toMatchObject({ removed: 1, planned_groups: 1, planned_removals: 1 });
    expect(A.exploreConsolidatePlan().group_total).toBe(0);
    // Nothing left to merge: no second call, no undo group.
    const again = A.exploreConsolidateFootage({ expect: GUARD });
    expect(again).toMatchObject({ no_op: true });
    expect(called).toBe(1);
    expect(undo.begun).toBe(1);
  });

  it("refuses a missing consolidateFootage and a wrong guard before the undo group", () => {
    const { project } = footageScene();
    const { A, undo } = loadHost(project, ["layout.jsx"]);
    expect(thrown(() => A.exploreConsolidateFootage({ expect: GUARD })).message).toContain("consolidateFootage");
    expect(thrown(() => A.exploreConsolidateFootage({ expect: { project_path: "C:/x.aep" } })).kind).toBe("guard");
    expect(undo.begun).toBe(0);
  });

  function treeScene() {
    const { project, comp } = scene();
    const inner = project.addComp("Inner", 100, 100, 2);
    const other = project.addComp("Other", 100, 100, 2);
    const used = project.addFootage("used.png", 10, 10) as FakeFootage;
    const spare = project.addFootage("spare.png", 10, 10) as FakeFootage;
    const deep = project.addFootage("deep.png", 10, 10) as FakeFootage;
    comp.layers.add(inner);
    comp.layers.add(used);
    inner.layers.add(deep);
    other.layers.add(spare);
    return { project, comp, inner, other, used, spare, deep };
  }

  it("the reduce plan follows layers and nested comps and lists the rest", () => {
    const { project, comp, other, spare } = treeScene();
    const { A } = loadHost(project, ["layout.jsx"]);
    const plan = A.exploreReducePlan({ comp_ids: [comp.id] });
    expect(plan.keep_comps).toEqual([{ id: comp.id, name: "Main" }]);
    expect(plan.kept_items).toBe(4);
    expect(plan.remove.map((r: any) => r.id).sort()).toEqual([other.id, spare.id].sort());
    expect(plan.remove.find((r: any) => r.id === other.id).kind).toBe("comp");
    expect(plan.remove_total).toBe(2);
  });

  it("the plan refuses a missing id or an item that is not a comp", () => {
    const { project, used } = treeScene();
    const { A } = loadHost(project, ["layout.jsx"]);
    expect(thrown(() => A.exploreReducePlan({ comp_ids: [999999] })).message).toContain("No project item");
    expect(thrown(() => A.exploreReducePlan({ comp_ids: [used.id] })).message).toContain("not a comp");
    expect(thrown(() => A.exploreReducePlan({ comp_ids: [] })).message).toContain("at least one comp");
  });

  it("reduces the live project to the chosen comps with the comps themselves, in one undo group", () => {
    const { project, comp, other, spare } = treeScene();
    const kept: number[][] = [];
    (project as any).reduceProject = (items: Array<{ id: number }>) => {
      kept.push(items.map((i) => i.id));
      project.all = project.all.filter((x) => x !== other && x !== spare);
      return 2;
    };
    const { A, undo } = loadHost(project, ["layout.jsx"]);
    const r = A.exploreReduceProject({ comp_ids: [comp.id], expect: GUARD });
    expect(kept).toEqual([[comp.id]]);
    expect(undo.begun).toBe(1);
    expect(r).toMatchObject({ removed: 2, planned_removals: 2 });
    expect(A.exploreReducePlan({ comp_ids: [comp.id] }).remove_total).toBe(0);
    expect(A.exploreReduceProject({ comp_ids: [comp.id], expect: GUARD })).toMatchObject({ no_op: true });
    expect(undo.begun).toBe(1);
  });

  it("refuses an AE without reduceProject before the undo group", () => {
    const { project, comp } = treeScene();
    const { A, undo } = loadHost(project, ["layout.jsx"]);
    expect(thrown(() => A.exploreReduceProject({ comp_ids: [comp.id], expect: GUARD })).message).toContain("reduceProject");
    expect(undo.begun).toBe(0);
  });
});

describe("production.jsx: Essential Graphics media replacement", () => {
  function templated() {
    const { project, comp: main } = scene();
    const tpl = project.addComp("Template", 200, 200, 2);
    tpl.controllers.push("Title", "Logo");
    const logoA = project.addFootage("logoA.png", 10, 10) as FakeFootage;
    const logoB = project.addFootage("logoB.png", 10, 10) as FakeFootage;
    const layer = main.layers.add(tpl) as FakeLayer;
    const { A, undo, G } = loadHost(project, ["production.jsx"]);
    const g = layer.property("ADBE Layer Overrides") as FakeGroup;
    const logo = g.property("Logo") as any;
    let current: any = logoA;
    // AVItem.isMediaReplacementCompatible is a Boolean attribute of the candidate item, not a method.
    (logoB as any).isMediaReplacementCompatible = true;
    logo.canSetAlternateSource = true;
    Object.defineProperty(logo, "alternateSource", { get: () => current });
    logo.setAlternateSource = (item: any) => {
      current = item;
    };
    return { A, undo, G, project, main, tpl, layer, g, logo, logoA, logoB, set: (v: any) => (current = v) };
  }

  it("egpRead describes where each override comes from and its media, groups included", () => {
    const { A, main, layer, g, logo, logoA } = templated();
    const prop = new FakeProperty("Opacity", "ADBE Opacity", PropertyValueType.OneD, 100) as any;
    prop.propertyDepth = 3;
    prop.propertyGroup = () => layer;
    prop.parentProperty = null;
    logo.essentialPropertySource = prop;
    const title = g.property("Title") as any;
    title.essentialPropertySource = layer;
    const nested = new FakeProperty("Tint", "tint", PropertyValueType.OneD, 5) as any;
    nested.essentialPropertySource = null;
    g.props.push(new FakeGroup("Colors", "colors", [nested]));
    const r = A.egpRead({ comp_id: main.id, layer: { index: 1 } });
    const byName = (n: string) => r.overrides.find((o: any) => o.name === n);
    expect(byName("Logo")).toMatchObject({ can_set_alternate_source: true, alternate_source_id: logoA.id });
    expect(byName("Logo").source).toMatchObject({ name: "Opacity", match_name: "ADBE Opacity", layer_id: layer.id });
    expect(byName("Title").source).toEqual({ kind: "layer", layer_id: layer.id, layer_name: layer.name });
    expect(byName("Colors")).toMatchObject({ kind: "group" });
    expect(byName("Colors").children[0]).toMatchObject({ name: "Tint", source: null });
    // The raw AE object is never returned.
    expect(JSON.stringify(r)).not.toContain("[object");
  });

  it("the set_media read-back checks the same property the host wrote: top-level first", () => {
    const tree = [
      { index: 1, name: "Colors", kind: "group" as const, children: [{ index: 1, name: "Logo", alternate_source_id: 5 }] },
      { index: 2, name: "Logo", alternate_source_id: 9 },
    ];
    const args = AeSetEssentialGraphicsSchema.parse({ comp_id: 1, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: 9, expect: expectArg });
    const state = { template_name: null, controllers: [], overrides: tree };
    expect(egpMismatches(args, state, state)).toEqual([]);
  });

  it("egpRead on an AE without essentialPropertySource leaves source out", () => {
    const { A, main } = templated();
    const r = A.egpRead({ comp_id: main.id, layer: { index: 1 } });
    expect(r.overrides[0].source).toBeUndefined();
    expect(r.overrides[0].kind).toBeUndefined();
  });

  it("set_media puts the item behind the slot in one undo group", () => {
    const { A, undo, main, logoB } = templated();
    const r = A.egpEdit({ comp_id: main.id, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: logoB.id, expect: GUARD });
    expect(r).toMatchObject({ action: "set_media", name: "Logo", item_id: logoB.id });
    expect(undo.begun).toBe(1);
    expect(A.egpRead({ comp_id: main.id, layer: { index: 1 } }).overrides.find((o: any) => o.name === "Logo").alternate_source_id).toBe(logoB.id);
  });

  it("set_media refuses before the undo group: not a slot, incompatible media, a folder, a missing item, an old AE", () => {
    const { A, undo, main, logo, logoA, logoB, project, g } = templated();
    const call = (over: Record<string, unknown>) => thrown(() => A.egpEdit({ comp_id: main.id, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: logoB.id, expect: GUARD, ...over }));
    const title = g.property("Title") as any;
    title.canSetAlternateSource = false;
    title.setAlternateSource = () => undefined;
    expect(call({ name: "Title" }).message).toContain("canSetAlternateSource");
    (logoB as any).isMediaReplacementCompatible = false;
    expect(call({}).message).toContain("not compatible");
    (logoB as any).isMediaReplacementCompatible = true;
    expect(call({ item_id: project.rootFolder.id }).message).toContain("No project item");
    const folder = project.addFolder("F");
    expect(call({ item_id: folder.id }).message).toContain("folder");
    expect(call({ item_id: 987654 }).message).toContain("No project item");
    expect(call({ name: "Nope" }).message).toContain("No Essential Property");
    delete logo.setAlternateSource;
    (g.property("Logo") as any).setAlternateSource = undefined;
    expect(call({}).message).toContain("setAlternateSource");
    expect(call({}).kind).toBe("bad_args");
    void logoA;
    expect(undo.begun).toBe(0);
  });

  it("set_media says so when this AE has no isMediaReplacementCompatible", () => {
    const { A, undo, main, logoB } = templated();
    delete (logoB as any).isMediaReplacementCompatible;
    const r = A.egpEdit({ comp_id: main.id, action: "set_media", layer: { index: 1 }, name: "Logo", item_id: logoB.id, expect: GUARD });
    expect(r.note).toContain("not checked");
    expect(undo.begun).toBe(1);
  });

  it("describes a layer source as a layer even though a real Layer has propertyType", () => {
    const { A, main, layer, g } = templated();
    (layer as any).propertyType = PropertyType_GROUP;
    (layer as any).propertyDepth = 0;
    (g.property("Title") as any).essentialPropertySource = layer;
    const r = A.egpRead({ comp_id: main.id, layer: { index: 1 } });
    expect(r.overrides.find((o: any) => o.name === "Title").source).toEqual({ kind: "layer", layer_id: layer.id, layer_name: layer.name });
  });

  it("add without a path adds the layer's media slot, and says so when the layer cannot", () => {
    const { A, undo, main, tpl, layer } = templated();
    const inner = tpl.layers.addSolid([1, 1, 1], "Plate", 10, 10, 1) as FakeLayer;
    void layer;
    expect(thrown(() => A.egpEdit({ comp_id: tpl.id, action: "add", layer: { index: 1 }, expect: GUARD })).message).toContain("cannot add a layer's media");
    (inner as any).canAddToMotionGraphicsTemplate = () => true;
    (inner as any).addToMotionGraphicsTemplateAs = (c: any, n: string) => c.controllers.push(n);
    (inner as any).addToMotionGraphicsTemplate = (c: any) => c.controllers.push("Plate");
    const before = tpl.controllers.length;
    const r = A.egpEdit({ comp_id: tpl.id, action: "add", layer: { index: 1 }, name: "Media", expect: GUARD });
    expect(r.count).toBe(before + 1);
    expect(undo.begun).toBe(1);
    void main;
  });

  it("set_override still finds a top-level Essential Property", () => {
    const { A, main } = templated();
    const r = A.egpEdit({ comp_id: main.id, action: "set_override", layer: { index: 1 }, name: "Title", value: 3, expect: GUARD });
    expect(r).toMatchObject({ action: "set_override", name: "Title" });
  });
});

describe("production.jsx: saving render templates", () => {
  function queued() {
    const { project, comp } = scene();
    const other = project.addComp("Other", 100, 100, 2);
    const rq = project.renderQueue as any;
    const mk = (c: any) => {
      const item = rq.items.add(c);
      item.templates = ["Best Settings", "Draft Settings"];
      item.status = 1;
      item.numOutputModules = 2;
      const oms = [1, 2].map(() => ({ templates: ["Lossless"], saveAsTemplate(this: any, n: string) { this.templates = [...this.templates, n]; } }));
      item.outputModule = (i: number) => oms[i - 1];
      item.saveAsTemplate = (n: string) => {
        item.templates = [...item.templates, n];
      };
      return item;
    };
    const item1 = mk(comp);
    const item2 = mk(other);
    const { A, undo, G } = loadHost(project, ["production.jsx"]);
    G.RQItemStatus = { RENDERING: 99 };
    const base = { kind: "render_settings", item_index: 1, item_comp_id: comp.id, name: "Mine", expect: GUARD };
    return { A, undo, G, comp, other, item1, item2, base };
  }

  it("the name collision check scans past the 500 names the list is capped at", () => {
    const { A, base, item1 } = queued();
    item1.templates = Array.from({ length: 600 }, (_, i) => `T${i}`);
    const err = thrown(() => A.exploreSaveTemplate({ ...base, name: "t550" }));
    expect(err.message).toContain("already exists");
    expect(A.exploreRqTemplates(base).truncated).toBe(true);
  });

  it("exploreRqTemplates lists the names for the item and says whether one exists", () => {
    const { A, base, other } = queued();
    const r = A.exploreRqTemplates({ ...base, name: "best settings" });
    expect(r).toMatchObject({ kind: "render_settings", templates: ["Best Settings", "Draft Settings"], exists: true, count: 2, truncated: false });
    expect(r.item).toMatchObject({ index: 1, comp_name: "Main" });
    const om = A.exploreRqTemplates({ kind: "output_module", item_index: 2, item_comp_id: other.id, om_index: 2 });
    expect(om).toMatchObject({ templates: ["Lossless"], om_index: 2 });
    expect(om.exists).toBeUndefined();
  });

  it("saves a render-settings template without an undo group (a preference, not a project change)", () => {
    const { A, undo, base, item1 } = queued();
    const r = A.exploreSaveTemplate(base);
    expect(r).toMatchObject({ saved: "Mine", kind: "render_settings", replaced: false, item_index: 1 });
    expect(item1.templates).toContain("Mine");
    expect(undo.begun).toBe(0);
  });

  it("saves an output-module template on the chosen module", () => {
    const { A, base, item1 } = queued();
    A.exploreSaveTemplate({ ...base, kind: "output_module", om_index: 2, name: "Master" });
    expect(item1.outputModule(2).templates).toContain("Master");
    expect(item1.outputModule(1).templates).not.toContain("Master");
    expect(item1.templates).not.toContain("Master");
  });

  it("refuses an existing name (any case) unless allow_replace, and always a blank one", () => {
    const { A, undo, base } = queued();
    expect(thrown(() => A.exploreSaveTemplate({ ...base, name: "best settings" })).message).toContain("already exists");
    expect(thrown(() => A.exploreSaveTemplate({ ...base, name: "   " })).message).toContain("empty");
    expect(thrown(() => A.exploreSaveTemplate({ ...base, name: "bad\nname" })).message).toContain("control");
    expect(undo.begun).toBe(0);
    const r = A.exploreSaveTemplate({ ...base, name: "Best Settings", allow_replace: true });
    expect(r.replaced).toBe(true);
    expect(undo.begun).toBe(0);
  });

  it("guards the item by index and comp id, the output module index and a running render", () => {
    const { A, undo, base, other, item1, G } = queued();
    const wrong = thrown(() => A.exploreSaveTemplate({ ...base, item_comp_id: other.id }));
    expect(wrong.kind).toBe("guard");
    expect(thrown(() => A.exploreSaveTemplate({ ...base, item_index: 5 })).message).toContain("out of range");
    expect(thrown(() => A.exploreSaveTemplate({ ...base, kind: "output_module", om_index: 3 })).message).toContain("Output module 3");
    expect(thrown(() => A.exploreSaveTemplate({ ...base, kind: "other" })).message).toContain("kind");
    item1.status = G.RQItemStatus.RENDERING;
    expect(thrown(() => A.exploreSaveTemplate(base)).message).toContain("rendering");
    item1.status = 1;
    expect(thrown(() => A.exploreSaveTemplate({ ...base, expect: { project_path: "C:/x.aep" } })).kind).toBe("guard");
    expect(undo.begun).toBe(0);
    expect(item1.templates).toEqual(["Best Settings", "Draft Settings"]);
  });

  it("says when this AE has no saveAsTemplate", () => {
    const { A, base, item1 } = queued();
    delete item1.saveAsTemplate;
    expect(thrown(() => A.exploreSaveTemplate(base)).message).toContain("saveAsTemplate");
  });
});

const PropertyType_GROUP = 6212;

describe("production.jsx: batch with paths, markers, ranges and expression errors", () => {
  function batchScene() {
    const { project, comp } = scene();
    const solid = comp.layers.addSolid([1, 1, 1], "Plate", 100, 100, 1) as FakeLayer;
    const shapeLayer = comp.layers.addShape() as FakeLayer;
    (shapeLayer.property("ADBE Root Vectors Group") as FakeGroup).addProperty("ADBE Vector Shape - Group");
    const op = solid.transform("ADBE Opacity") as any;
    op.hasMin = true;
    op.minValue = 0;
    op.hasMax = true;
    op.maxValue = 100;
    const { A, undo } = loadHost(project, ["production.jsx"]);
    const shapePath = ["ADBE Root Vectors Group", "ADBE Vector Shape - Group", "ADBE Vector Shape"];
    return { A, undo, comp, solid, shapeLayer, shapePath, op };
  }
  const tri = { vertices: [[0, 0], [10, 0], [10, 10]], closed: true };

  it("validates ranges, paths, markers, separated dimensions and expression_enabled before anything is written", () => {
    const { A, comp, solid, shapeLayer, shapePath, undo } = batchScene();
    const check = (ops: unknown[]) => A.batchValidate({ comp_id: comp.id, ops });
    const layer = { id: solid.id };
    expect(check([{ layer, path: opacity, value: 50 }])).toEqual({ ok: true, checked: 1 });
    expect(check([{ layer, path: opacity, value: 150 }])).toMatchObject({ ok: false });
    expect(check([{ layer, path: opacity, value: 150 }]).error).toContain("accepts 100");
    expect(check([{ layer, path: opacity, value: "50" }]).error).toContain("one number");
    expect(check([{ layer, path: ["ADBE Transform Group", "ADBE Scale"], value: [1] }]).error).toContain("array of 2 or 3");
    expect(check([{ layer: { id: shapeLayer.id }, path: shapePath, value: tri }])).toMatchObject({ ok: true });
    expect(check([{ layer: { id: shapeLayer.id }, path: shapePath, value: { vertices: [[0, "x"]] } }]).error).toContain("vertices[0]");
    expect(check([{ layer: { id: shapeLayer.id }, path: shapePath, value: { vertices: [] } }]).ok).toBe(false);
    expect(check([{ layer, path: ["ADBE Marker"], value: { comment: "x" } }]).error).toContain("markers are keys");
    expect(check([{ layer, path: ["ADBE Marker"], keyframes: [{ time: 1, value: { comment: "x" } }] }]).ok).toBe(true);
    expect(check([{ layer, path: opacity, expression_enabled: true }]).error).toContain("no expression to switch on");
    (solid.transform("ADBE Position") as any).dimensionsSeparated = true;
    expect(check([{ layer, path: ["ADBE Transform Group", "ADBE Position"], value: [1, 2] }]).error).toContain("separated");
    expect(undo.begun).toBe(0);
  });

  it("batchValidate and batchSet accept a missing font only with allow_substitute", () => {
    const { A, comp } = batchScene();
    const text = comp.layers.addText("Hi") as FakeLayer;
    const textPath = ["ADBE Text Properties", "ADBE Text Document"];
    A.fontsResolve = () => ({ ok: false, reason: "Not installed." });
    const ops = [{ layer: { id: text.id }, path: textPath, value: { text: "x", font: "Nope-Regular" } }];
    expect(A.batchValidate({ comp_id: comp.id, ops }).error).toContain("not available");
    expect(A.batchValidate({ comp_id: comp.id, ops, allow_substitute: true }).ok).toBe(true);
    const r = A.batchSet({ comp_id: comp.id, ops, allow_substitute: true, expect: GUARD });
    expect(r.failed_at).toBeUndefined();
    expect(r.done).toBe(1);
  });

  it("an op's own allow_substitute lets a missing font through the check and the write", () => {
    const { A, comp } = batchScene();
    const text = comp.layers.addText("Hi") as FakeLayer;
    const textPath = ["ADBE Text Properties", "ADBE Text Document"];
    A.fontsResolve = () => ({ ok: false, reason: "Not installed." });
    const ops = [{ layer: { id: text.id }, path: textPath, value: { text: "x", font: "Nope-Regular" }, allow_substitute: true }];
    expect(A.batchValidate({ comp_id: comp.id, ops }).ok).toBe(true);
    const r = A.batchSet({ comp_id: comp.id, ops, expect: GUARD });
    expect(r.failed_at).toBeUndefined();
    expect(r.done).toBe(1);
  });

  it("validates path vertex counts and fonts up front, as setProperty would", () => {
    const { A, comp, solid, shapeLayer, shapePath } = batchScene();
    const check = (ops: unknown[]) => A.batchValidate({ comp_id: comp.id, ops });
    const sl = { id: shapeLayer.id };
    const quad = { vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true };
    expect(check([{ layer: sl, path: shapePath, keyframes: [{ time: 0, value: tri }, { time: 1, value: quad }] }]).error).toContain("same number of vertices");
    // A keyframed path keeps its vertex count.
    A.batchSet({ comp_id: comp.id, ops: [{ layer: sl, path: shapePath, keyframes: [{ time: 0, value: tri }, { time: 1, value: tri }] }], expect: GUARD });
    expect(check([{ layer: sl, path: shapePath, value: quad }]).error).toContain("keyframed with 3 vertices");
    expect(check([{ layer: sl, path: shapePath, value: tri }]).ok).toBe(true);
    // A font that is not installed is refused before the first write of the chunk.
    const text = comp.layers.addText("Hi") as FakeLayer;
    const textPath = ["ADBE Text Properties", "ADBE Text Document"];
    A.fontsResolve = (spec: any) => (spec.postscript === "Nope-Regular" ? { ok: false, reason: "Not installed." } : { ok: true });
    expect(check([{ layer: { id: text.id }, path: textPath, value: { text: "x", font: "Nope-Regular" } }]).error).toContain("not available");
    expect(check([{ layer: { id: text.id }, path: textPath, value: { text: "x", font: "Arial-Black" } }]).ok).toBe(true);
    void solid;
  });

  it("writes a path and a marker, and the read-back returns them as data the checker accepts", () => {
    const { A, comp, shapeLayer, solid, shapePath } = batchScene();
    const ops = [
      { layer: { id: shapeLayer.id }, path: shapePath, value: { ...tri, inTangents: [[0, 0], [1, 1], [0, 0]] } },
      { layer: { id: solid.id }, path: ["ADBE Marker"], keyframes: [{ time: 1, value: { comment: "Beat", duration: 0.5 } }] },
    ];
    const w = A.batchSet({ comp_id: comp.id, ops, expect: GUARD });
    expect(w).toMatchObject({ done: 2 });
    const read = A.batchRead({ comp_id: comp.id, ops: ops.map((o, i) => ({ layer: o.layer, path: o.path, ...(i === 1 ? { times: [1] } : {}) })) });
    expect(read.results[0].value).toMatchObject({ closed: true, num_vertices: 3 });
    expect(read.results[1].keys[0].value).toMatchObject({ comment: "Beat" });
    const parsed = AeBatchSetSchema.parse({ comp_id: comp.id, ops, expect: expectArg }).ops;
    expect(batchMismatches(parsed, read, 0)).toEqual([]);
    // A different path is caught.
    const wrong = JSON.parse(JSON.stringify(read));
    wrong.results[0].value.vertices[2] = [10, 99];
    expect(batchMismatches(parsed, wrong, 0).map((m) => m.path)).toEqual(["ops[1].value.vertices[2]"]);
  });

  it("sets expression_enabled alone and reports a broken expression in the read-back", () => {
    const { A, comp, solid, op } = batchScene();
    const layer = { id: solid.id };
    A.batchSet({ comp_id: comp.id, ops: [{ layer, path: opacity, expression: "wiggle(1, 5)", expression_enabled: true }], expect: GUARD });
    expect(op.expressionEnabled).toBe(true);
    const off = A.batchSet({ comp_id: comp.id, ops: [{ layer, path: opacity, expression_enabled: false }], expect: GUARD });
    expect(off).toMatchObject({ done: 1 });
    expect(op.expressionEnabled).toBe(false);
    // Now an expression AE cannot evaluate.
    op.valueAtTime = function (this: any) {
      this.expressionError = "wigle is not defined";
      throw new Error("wigle is not defined");
    };
    A.batchSet({ comp_id: comp.id, ops: [{ layer, path: opacity, expression: "wigle(1, 5)" }], expect: GUARD });
    const readOps = [{ layer, path: opacity, check_expression: true }];
    const read = A.batchRead({ comp_id: comp.id, ops: readOps });
    expect(read.results[0].expression_error).toContain("wigle");
    const parsed = AeBatchSetSchema.parse({ comp_id: comp.id, ops: [{ layer, path: opacity, expression: "wigle(1, 5)" }], expect: expectArg }).ops;
    expect(batchMismatches(parsed, read, 0).map((m) => m.path)).toEqual(["ops[1].expression_error"]);
    // Without check_expression the property is not evaluated at all.
    let evaluated = 0;
    op.valueAtTime = () => {
      evaluated++;
      return 1;
    };
    const quiet = A.batchRead({ comp_id: comp.id, ops: [{ layer, path: opacity }] });
    expect(quiet.results[0].expression_error).toBeUndefined();
    expect(evaluated).toBe(0);
  });

  it("an out-of-range batch stops at validation: nothing is written, no undo group opens", () => {
    const { A, comp, solid, undo, op } = batchScene();
    expect(() => A.batchSet({ comp_id: comp.id, ops: [{ layer: { id: solid.id }, path: opacity, value: 40 }, { layer: { id: solid.id }, path: opacity, value: 400 }], expect: GUARD })).toThrow();
    expect(undo.begun).toBe(0);
    expect(op.staticValue).toBe(100);
  });
});
