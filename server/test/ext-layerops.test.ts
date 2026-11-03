import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeLayerOpsSchema,
  copiedToCompWarnings,
  findIndexReferences,
  findNameReferences,
  indexMapFromOrder,
  indexMapFromStack,
  indexReferenceWarnings,
  layerOpsMismatches,
  layeropsTools,
  nameReferenceWarnings,
  type OpsLayer,
  type OpsStack,
} from "../src/tools/ext/layerops.js";
import { zodToJsonSchema } from "../src/schema.js";
import { FakeComp, FakeLayer, FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = layeropsTools.find((t) => t.name === "ae_layer_ops")!;
const expectArg = { project_path: "<unsaved>" };

// ---------- fake bridge ----------

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-layerops-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const L = (index: number, id: number, name: string, extra: Partial<OpsLayer> = {}): OpsLayer => ({
  index,
  id,
  name,
  kind: "solid",
  enabled: true,
  parent: null,
  ...extra,
});

const stack = (layers: OpsLayer[], extra: Partial<OpsStack> = {}): OpsStack => ({
  comp_id: 1,
  name: "Main",
  numLayers: layers.length,
  frameDuration: 0.04,
  layers,
  ...extra,
});

const ex = (layer: OpsLayer, text: string, path = "Transform > Opacity") => ({
  layer_id: layer.id,
  layer_index: layer.index,
  layer_name: layer.name,
  path,
  text,
  enabled: true,
});

// ---------- schema ----------

describe("AeLayerOpsSchema", () => {
  const base = { comp_id: 1, expect: expectArg };

  it("takes each action with its own parameters", () => {
    const ok = (v: object) => expect(AeLayerOpsSchema.safeParse({ ...base, ...v }).success).toBe(true);
    ok({ action: "parent", layers: [{ index: 2 }], parent: { name: "Ctrl" } });
    ok({ action: "parent", layers: [{ index: 2 }], unparent: true });
    ok({ action: "reorder", layers: [{ index: 2 }], move_to: "before", relative_to: { index: 1 } });
    ok({ action: "sort", sort_by: "name" });
    ok({ action: "duplicate", where: { kind: "text" }, count: 3 });
    ok({ action: "delete", layers: [{ id: 5 }] });
    ok({ action: "trim", layers: [{ index: 1 }], in_point: 1, out_point: 2 });
    ok({ action: "rename", where: { label: 3 }, find: "a", replace: "b" });
    ok({ action: "switches", layers: [{ index: 1 }], shy: true, blend_mode: "multiply", label_color: 4 });
  });

  it("needs layers or where, except for sort", () => {
    expect(AeLayerOpsSchema.safeParse({ ...base, action: "delete" }).success).toBe(false);
    expect(AeLayerOpsSchema.safeParse({ ...base, action: "delete", where: {} }).success).toBe(false);
    expect(AeLayerOpsSchema.safeParse({ ...base, action: "sort", sort_by: "z" }).success).toBe(true);
  });

  it("refuses parameters of another action instead of ignoring them", () => {
    const r = AeLayerOpsSchema.safeParse({ ...base, action: "delete", layers: [{ index: 1 }], find: "x" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("find does not apply to the delete action");
  });

  it("checks the per-action rules", () => {
    const bad = (v: object) => expect(AeLayerOpsSchema.safeParse({ ...base, ...v }).success).toBe(false);
    const l = { layers: [{ index: 1 }] };
    bad({ action: "parent", ...l });
    bad({ action: "parent", ...l, parent: { index: 2 }, unparent: true });
    bad({ action: "parent", ...l, unparent: true, keep_position: false });
    bad({ action: "reorder", ...l });
    bad({ action: "reorder", ...l, move_to: "after" });
    bad({ action: "reorder", ...l, move_to: "end", relative_to: { index: 1 } });
    bad({ action: "sort" });
    bad({ action: "duplicate", ...l, to_comp_id: 1 });
    bad({ action: "duplicate", ...l, to_comp_id: 2, count: 2 });
    bad({ action: "trim", ...l });
    bad({ action: "trim", ...l, in_point: 5, out_point: 2 });
    bad({ action: "rename", ...l });
    bad({ action: "rename", ...l, replace: "x" });
    bad({ action: "switches", ...l });
    bad({ action: "switches", ...l, blend_mode: "sparkle" });
    bad({ action: "switches", ...l, label_color: 17 });
  });

  it("ends its description with the agent safety guidance", () => {
    expect(tool.description.endsWith("a target guard failure (kind: 'guard') means STOP and re-read state—do NOT retry with stale expectations.")).toBe(true);
  });

  it("converts to a JSON schema that exposes the tool's fields", () => {
    const json = zodToJsonSchema(AeLayerOpsSchema) as { properties?: Record<string, unknown> };
    for (const key of ["action", "layers", "sort_by", "comp_id", "expect"]) expect(Object.keys(json.properties ?? {})).toContain(key);
  });
});

// ---------- expression scan ----------

describe("findIndexReferences", () => {
  it("finds this comp's literal and relative layer references", () => {
    const refs = findIndexReferences(
      "a = thisComp.layer(3).transform.position;\nb = layer( 2 ).opacity;\nc = comp(\"Other\").layer(4).opacity;\nd = thisComp.layer(index - 1).opacity;\ne = thisComp.layer(index + 2);"
    );
    expect(refs.map((r) => [r.relative, r.value])).toEqual([
      [false, 3],
      [false, 2],
      [true, -1],
      [true, 2],
    ]);
  });

  it("ignores comments, strings, other receivers and names", () => {
    expect(findIndexReferences("// layer(9)\n/* thisComp.layer(8) */ x = \"layer(7)\"; thisComp.layer(\"Ctrl\").opacity; myLayer(5)")).toEqual([]);
    expect(findIndexReferences("footage(\"a\").layer(2)")).toEqual([]);
  });

  it("flags index arithmetic it can't evaluate", () => {
    const refs = findIndexReferences("thisComp.layer(Math.max(1, index - 1))");
    expect(refs).toEqual([]);
    const odd = findIndexReferences("thisComp.layer(index * 2)");
    expect(odd).toHaveLength(1);
    expect(odd[0]).toMatchObject({ relative: true, parsed: false });
  });
});

describe("findNameReferences", () => {
  it("reads quoted names of this comp's layers, not other comps'", () => {
    expect(findNameReferences("thisComp.layer(\"Ctrl\").opacity + layer('Other \\'x\\'').opacity + comp(\"C\").layer(\"No\")")).toEqual(["Ctrl", "Other 'x'"]);
    expect(findNameReferences("// layer(\"Gone\")")).toEqual([]);
  });
});

describe("indexReferenceWarnings", () => {
  const A = L(1, 10, "A");
  const B = L(2, 11, "B");
  const C = L(3, 12, "C");
  const before = stack([A, B, C], {
    expressions: [ex(A, "thisComp.layer(3).opacity"), ex(B, "thisComp.layer(index - 1).opacity"), ex(C, "thisComp.layer(\"A\").opacity")],
  });

  it("warns about a literal index that now reads another layer, with a rewrite", () => {
    const after = stack([L(1, 12, "C"), L(2, 10, "A"), L(3, 11, "B")]);
    const byIndex = new Map(after.layers.map((l) => [l.index, l]));
    const w = indexReferenceWarnings(before, indexMapFromStack(before, after), (i) => {
      const l = byIndex.get(i);
      return l && { layer_id: l.id, layer_name: l.name };
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      layer_name: "A",
      kind: "index",
      was: { index: 3, layer_name: "C" },
      now: { index: 3, layer_name: "B" },
      suggested_expression: "thisComp.layer(1).opacity",
    });
  });

  it("never suggests a rewrite for an expression the host cut, and says the scan is partial", () => {
    const cut = { ...ex(A, "thisComp.layer(3).opacity"), text_truncated: true, text_length: 30000 };
    const b = stack([A, B, C], { expressions: [cut] });
    const after = stack([L(1, 12, "C"), L(2, 10, "A"), L(3, 11, "B")]);
    const w = indexReferenceWarnings(b, indexMapFromStack(b, after), () => undefined);
    expect(w.some((x) => x.kind === "partial_scan")).toBe(true);
    expect(w.filter((x) => x.kind === "index").every((x) => x.suggested_expression === undefined)).toBe(true);
  });

  it("warns about the destination comp's index references and the copies' own references after a copy to another comp", () => {
    const D1 = L(1, 20, "D1");
    const D2 = L(2, 21, "D2");
    const dest = stack([D1, D2], { comp_id: 2, expressions: [ex(D1, "thisComp.layer(2).opacity")] });
    const src = stack([A], { expressions: [ex(A, "thisComp.layer(3).opacity")], with_comp: dest });
    const destAfter = stack([L(1, 30, "A copy"), L(2, 20, "D1"), L(3, 21, "D2")], { comp_id: 2 });
    const aft = stack([A], { with_comp: destAfter });
    const w = copiedToCompWarnings(src, aft, { duplicates: [{ source_id: 10, id: 30, name: "A copy" }] });
    expect(w.some((x) => x.layer_name === "D1" && x.kind === "index")).toBe(true);
    expect(w.some((x) => x.kind === "copied_reference" && x.reference.includes("layer(3)"))).toBe(true);
  });

  it("leaves a relative reference alone while its target still sits just above", () => {
    // B keeps A above it, so layer(index - 1) still reads A.
    const after = stack([L(1, 12, "C"), L(2, 10, "A"), L(3, 11, "B")]);
    const w = indexReferenceWarnings(before, indexMapFromStack(before, after), () => undefined);
    expect(w.some((x) => x.layer_name === "B")).toBe(false);
  });

  it("warns about a relative reference whose neighbour changed", () => {
    const after = stack([L(1, 10, "A"), L(2, 12, "C"), L(3, 11, "B")]);
    const w = indexReferenceWarnings(before, indexMapFromStack(before, after), (i) => {
      const l = after.layers.find((x) => x.index === i);
      return l && { layer_id: l.id, layer_name: l.name };
    });
    // A's layer(3) also moved (C is at 2 now); B's layer(index - 1) read A and now reads C.
    expect(w.map((x) => [x.layer_name, x.kind])).toEqual([
      ["A", "index"],
      ["B", "relative_index"],
    ]);
    expect(w[1]!.now).toMatchObject({ layer_name: "C" });
  });

  it("says when the layer it pointed at is deleted", () => {
    const after = stack([L(1, 10, "A"), L(2, 11, "B")]);
    const w = indexReferenceWarnings(before, indexMapFromStack(before, after), () => undefined);
    expect(w[0]).toMatchObject({ layer_name: "A", kind: "index", now: null });
    expect(w[0]!.message).toContain("deleted");
  });

  it("predicts from a planned order, with new layers as null", () => {
    const map = indexMapFromOrder(before, [null, 10, 11, 12], false);
    const w = indexReferenceWarnings(before, map, () => undefined);
    // A now sits at 2 but its layer(3) now reads B: every index below the new layer moved by one.
    expect(w.map((x) => x.layer_name)).toEqual(["A"]);
  });

  it("does not judge layers past the host's list", () => {
    const small = stack([A, B], { numLayers: 3, truncated: true, expressions: [ex(A, "thisComp.layer(2).opacity")] });
    const after = stack([A], { numLayers: 3, truncated: true });
    expect(indexReferenceWarnings(small, indexMapFromStack(small, after), () => undefined)).toEqual([]);
  });

  it("skips disabled expressions", () => {
    const off = stack([A, B, C], { expressions: [{ ...ex(A, "thisComp.layer(3).opacity"), enabled: false }] });
    const after = stack([L(1, 12, "C"), L(2, 10, "A"), L(3, 11, "B")]);
    expect(indexReferenceWarnings(off, indexMapFromStack(off, after), () => undefined)).toEqual([]);
  });
});

describe("nameReferenceWarnings", () => {
  it("flags a name reference nobody answers to after a rename", () => {
    const after = stack([L(1, 10, "Head"), L(2, 11, "BG")], {
      expressions: [ex(L(2, 11, "BG"), "thisComp.layer(\"Title\").opacity + thisComp.layer(\"Head\").opacity")],
    });
    const w = nameReferenceWarnings(after, [{ id: 10, from: "Title", to: "Head" }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "name", reference: "layer(\"Title\")" });
  });

  it("is quiet when AE updated the reference or another layer took the name", () => {
    const after = stack([L(1, 10, "Head"), L(2, 11, "Title")], { expressions: [ex(L(2, 11, "Title"), "thisComp.layer(\"Title\").opacity")] });
    expect(nameReferenceWarnings(after, [{ id: 10, from: "Title", to: "Head" }])).toEqual([]);
  });
});

// ---------- receipt checks ----------

describe("layerOpsMismatches", () => {
  const before = stack([L(1, 10, "A"), L(2, 11, "B"), L(3, 12, "C")]);

  it("checks a re-parent by id across the index shift", () => {
    const after = stack([L(1, 10, "A", { parent: 3 }), L(2, 11, "B"), L(3, 12, "C")]);
    const w = { action: "parent", targets: [{ id: 10 }], applied_ids: [10], parent_id: 12 };
    expect(layerOpsMismatches({ action: "parent" }, before, after, w)).toEqual([]);
    const wrong = stack([L(1, 10, "A", { parent: 2 }), L(2, 11, "B"), L(3, 12, "C")]);
    expect(layerOpsMismatches({ action: "parent" }, before, wrong, w).map((m) => m.path)).toEqual(["layer[A].parent"]);
  });

  it("compares the order a reorder planned", () => {
    const after = stack([L(1, 12, "C"), L(2, 10, "A"), L(3, 11, "B")]);
    const w = { action: "reorder", targets: [{ id: 12 }], order_after: [12, 10, 11] };
    expect(layerOpsMismatches({ action: "reorder" }, before, after, w)).toEqual([]);
    expect(layerOpsMismatches({ action: "reorder" }, before, before, w).map((m) => m.path)).toEqual(["order"]);
  });

  it("counts layers for duplicates and deletes", () => {
    const dup = stack([L(1, 13, "A"), L(2, 10, "A"), L(3, 11, "B"), L(4, 12, "C")]);
    expect(layerOpsMismatches({ action: "duplicate" }, before, dup, { action: "duplicate", targets: [{ id: 10 }], duplicates: [{ source_id: 10, id: 13, name: "A" }] })).toEqual([]);
    expect(layerOpsMismatches({ action: "duplicate" }, before, before, { action: "duplicate", targets: [{ id: 10 }], duplicates: [{ source_id: 10, id: 13, name: "A" }] }).map((m) => m.path)).toEqual([
      "numLayers",
      "duplicate[13]",
    ]);
    const gone = stack([L(1, 10, "A"), L(2, 12, "C")]);
    expect(layerOpsMismatches({ action: "delete" }, before, gone, { action: "delete", targets: [{ id: 11 }], deleted: [{ id: 11, name: "B" }] })).toEqual([]);
  });

  it("flags a start time that did not take, and a layer reported as skipped whose times changed", () => {
    const b = stack([L(1, 10, "A", { startTime: 0, inPoint: 0, outPoint: 10 }), L(2, 11, "B", { startTime: 0, inPoint: 0, outPoint: 10 })]);
    const a = stack([L(1, 10, "A", { startTime: 0, inPoint: 1, outPoint: 5 }), L(2, 11, "B", { startTime: 0, inPoint: 0, outPoint: 7 })]);
    const w = {
      action: "trim",
      targets: [{ id: 10 }, { id: 11 }],
      applied_ids: [10],
      partial_ids: [11],
      trims: [
        { id: 10, start_time: 2, in_point: 1, out_point: 5 },
        { id: 11, start_time: 0, in_point: 1, out_point: 5 },
      ],
    };
    const paths = layerOpsMismatches({ action: "trim" }, b, a, w).map((m) => m.path);
    expect(paths).toContain("layer[A].startTime");
    expect(paths).toContain("layer[B].outPoint");
    expect(paths).toContain("layer[B]");
    // A skipped layer left as it was is fine.
    expect(layerOpsMismatches({ action: "trim" }, b, b, { ...w, applied_ids: [], partial_ids: [] })).toEqual([]);
  });

  it("flags a trim AE clamped and a rename that did not take", () => {
    const b = stack([L(1, 10, "A", { inPoint: 0, outPoint: 10 })]);
    const clamped = stack([L(1, 10, "A", { inPoint: 0, outPoint: 4 })]);
    const w = { action: "trim", targets: [{ id: 10 }], applied_ids: [10], trims: [{ id: 10, start_time: 0, in_point: 0, out_point: 6 }] };
    expect(layerOpsMismatches({ action: "trim" }, b, clamped, w).map((m) => m.path)).toEqual(["layer[A].outPoint"]);
    const r = { action: "rename", targets: [{ id: 10 }], applied_ids: [10], renames: [{ id: 10, from: "A", to: "Z" }] };
    expect(layerOpsMismatches({ action: "rename" }, b, b, r).map((m) => m.path)).toEqual(["layer[10].name"]);
  });

  it("flags a switch that did not take, and a layer outside the action that changed", () => {
    const after = stack([L(1, 10, "A", { shy: false }), L(2, 11, "B", { locked: true }), L(3, 12, "C")]);
    const b = stack([L(1, 10, "A", { shy: false }), L(2, 11, "B", { locked: false }), L(3, 12, "C")]);
    const w = { action: "switches", targets: [{ id: 10 }], changes: [{ id: 10, key: "shy", from: false, to: true }] };
    expect(layerOpsMismatches({ action: "switches" }, b, after, w).map((m) => m.path)).toEqual(["layer[A].shy", "layers[B].locked"]);
  });

  it("judges nothing for a no-op or a capped read", () => {
    expect(layerOpsMismatches({ action: "delete" }, before, before, { action: "delete", no_op: true, deleted: [{ id: 11, name: "B" }] })).toEqual([]);
    const big = stack([L(1, 10, "A")], { numLayers: 600, truncated: true });
    expect(layerOpsMismatches({ action: "delete" }, big, big, { action: "delete", targets: [{ id: 10 }], deleted: [{ id: 10, name: "A" }] }).map((m) => m.path)).toEqual(["numLayers"]);
  });
});

// ---------- the guarded flow ----------

describe("ae_layer_ops handler", () => {
  it("guards, reads, writes and reads back in a separate call, and warns about moved layer(index) references", async () => {
    const A = L(1, 10, "A");
    const C = L(3, 12, "C");
    const { ctx, calls } = fakeAe({
      layeropsRead: [
        stack([A, L(2, 11, "B"), C], { expressions: [ex(A, "thisComp.layer(3).opacity")] }),
        stack([L(1, 12, "C"), L(2, 10, "A"), L(3, 11, "B")], { expressions: [] }),
      ],
      layeropsApply: [
        { action: "reorder", targets: [{ id: 12, index: 3, name: "C" }], skipped: [], warnings: [], moves: 1, order_after: [12, 10, 11], moved_ids: [12], no_op: false },
      ],
    });
    const args = AeLayerOpsSchema.parse({ action: "reorder", comp_id: 1, layers: [{ name: "C" }], move_to: "beginning", expect: expectArg });
    const out = (await tool.handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "layeropsRead", "layeropsApply", "layeropsRead"]);
    expect(calls[1]!.script).toContain('"scan_expressions":true');
    // Only rename needs the expressions again after the write.
    expect(calls[3]!.script).not.toContain("scan_expressions");
    expect(calls[2]!.script).toContain('"expect"');
    expect(calls[2]!.script).not.toContain("dry_run");
    expect(out.receipt.matches).toBe(true);
    expect(out.stack_before.layers.map((l: any) => l.name)).toEqual(["A", "B", "C"]);
    expect(out.stack_after.layers.map((l: any) => l.name)).toEqual(["C", "A", "B"]);
    expect(out.order_after).toBeUndefined();
    expect(out.expression_warnings).toHaveLength(1);
    expect(out.expression_warnings[0]).toMatchObject({ layer_name: "A", kind: "index", now: { layer_name: "B" } });
  });

  it("puts a wrong result into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      layeropsRead: [stack([L(1, 10, "A"), L(2, 11, "B")]), stack([L(1, 10, "A"), L(2, 11, "B")])],
      layeropsApply: [{ action: "rename", targets: [{ id: 10 }], applied_ids: [10], renames: [{ id: 10, from: "A", to: "Z" }], skipped: [], warnings: [] }],
    });
    const args = AeLayerOpsSchema.parse({ action: "rename", comp_id: 1, layers: [{ index: 1 }], find: "A", replace: "Z", expect: expectArg });
    const out = (await tool.handler(args, ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("layer[10].name");
  });

  it("scans expressions only for the actions that move layers, and reads the target comp for a copy", async () => {
    const { ctx, calls } = fakeAe({
      layeropsRead: [stack([L(1, 10, "A")], { with_comp: stack([], { comp_id: 2 }) }), stack([L(1, 10, "A")], { with_comp: stack([L(1, 30, "A")], { comp_id: 2 }) })],
      layeropsApply: [{ action: "duplicate", to_comp_id: 2, targets: [{ id: 10 }], duplicates: [{ source_id: 10, id: 30, name: "A" }], duplicates_total: 1, skipped: [], warnings: [] }],
    });
    const args = AeLayerOpsSchema.parse({ action: "duplicate", comp_id: 1, layers: [{ index: 1 }], to_comp_id: 2, expect: expectArg });
    const out = (await tool.handler(args, ctx)) as any;
    expect(calls[1]!.script).toContain('"with_comp_id":2');
    expect(out.receipt.matches).toBe(true);

    const q = fakeAe({
      layeropsRead: [stack([L(1, 10, "A")]), stack([L(1, 10, "A", { shy: true })])],
      layeropsApply: [{ action: "switches", targets: [{ id: 10 }], changes: [{ id: 10, key: "shy", from: false, to: true }], skipped: [], warnings: [] }],
    });
    const sw = AeLayerOpsSchema.parse({ action: "switches", comp_id: 1, layers: [{ index: 1 }], shy: true, expect: expectArg });
    const out2 = (await tool.handler(sw, q.ctx)) as any;
    expect(q.calls[1]!.script).not.toContain("scan_expressions");
    expect(out2.receipt.matches).toBe(true);
  });

  it("a dry run reads and plans without a guard, a write or a checkpoint, and predicts the breaks", async () => {
    const A = L(1, 10, "A");
    const { ctx, calls } = fakeAe({
      layeropsRead: [stack([A, L(2, 11, "B"), L(3, 12, "C")], { expressions: [ex(A, "thisComp.layer(3).opacity")] })],
      layeropsPlan: [{ action: "reorder", targets: [{ id: 12 }], skipped: [], warnings: [], order_after: [12, 10, 11], moves: 1, dry_run: true, would_change: 1 }],
    });
    const args = AeLayerOpsSchema.parse({ action: "reorder", comp_id: 1, layers: [{ index: 3 }], move_to: "beginning", dry_run: true, expect: expectArg });
    const out = (await tool.handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["layeropsRead", "layeropsPlan"]);
    expect(calls[1]!.script).not.toContain("dry_run");
    expect(out.dry_run).toBe(true);
    expect(out.would_break_expressions).toHaveLength(1);
    expect(out.would_break_expressions[0]).toMatchObject({ layer_name: "A", now: { layer_name: "B" } });
    expect(out.checkpoint).toBeUndefined();
  });
});

// ---------- the host functions under node:vm ----------

const BM = { NORMAL: 1, MULTIPLY: 2, SCREEN: 3, ADD: 4 };
const LQ = { BEST: 1, DRAFT: 2, WIREFRAME: 3 };
const LS = { BILINEAR: 1, BICUBIC: 2 };

/** Gives a fake layer the switches and methods the simulated AE lacks. */
function decorate<T extends FakeLayer>(l: T): T {
  const a = l as any;
  a.shy = false;
  a.solo = false;
  a.motionBlur = false;
  a.collapseTransformation = false;
  a.quality = LQ.BEST;
  a.samplingQuality = LS.BILINEAR;
  a.blendingMode = BM.NORMAL;
  a.jumps = 0;
  const s = () => l.comp.stack;
  a.moveToBeginning = () => {
    s().splice(s().indexOf(l), 1);
    s().unshift(l);
  };
  a.setParentWithJump = (p?: FakeLayer) => {
    a.parent = p ?? null;
    a.jumps++;
  };
  a.duplicate = () => {
    const d = decorate(new FakeLayer(l.comp, l.name, l.reflect.name));
    d.source = l.source;
    s().splice(s().indexOf(l), 0, d);
    return d;
  };
  a.copyToComp = (dest: FakeComp) => {
    if (a.refuseCopy) throw new Error("cannot copy");
    dest.stack.unshift(decorate(new FakeLayer(dest, l.name, l.reflect.name)));
  };
  return l;
}

function scene(names: string[]) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 10);
  const host = loadHost(project, ["layerops.jsx"]);
  Object.assign(host.G, { BlendingMode: BM, LayerQuality: LQ, LayerSamplingQuality: LS });
  for (const n of [...names].reverse()) decorate(comp.layers.addSolid([1, 1, 1], n, 100, 100));
  return { project, comp, ...host };
}

const order = (c: FakeComp) => c.stack.map((l) => l.name);
const layer = (c: FakeComp, name: string) => c.layer(name) as any;
const sel = (...names: string[]) => names.map((name) => ({ name }));

describe("layerops.jsx: expression scan bounds", () => {
  it("keeps long expressions to the 20k bound with a flag, and returns only those that mention layer", () => {
    const { comp, A } = scene(["A"]);
    const op = layer(comp, "A").transform("Opacity");
    op.expression = "thisComp.layer(2).opacity;" + "x".repeat(25000);
    op.expressionEnabled = true;
    const pos = layer(comp, "A").transform("Position");
    pos.expression = "wiggle(1, 2)";
    pos.expressionEnabled = true;
    const s = A.layeropsRead({ comp_id: comp.id, scan_expressions: true });
    expect(s.expressions).toHaveLength(1);
    expect(s.expressions[0].text).toHaveLength(20000);
    expect(s.expressions[0].text_truncated).toBe(true);
    expect(s.expressions[0].text_length).toBeGreaterThan(25000);
  });
});

describe("layerops.jsx: read", () => {
  it("lists the stack with switches and finds expressions in nested properties, without changing anything", () => {
    const { comp, A, undo } = scene(["Ctrl", "Logo", "BG"]);
    layer(comp, "Logo").parent = layer(comp, "Ctrl");
    layer(comp, "Logo").label = 5;
    layer(comp, "Logo").transform("Opacity").expression = "thisComp.layer(3).transform.opacity";
    layer(comp, "Logo").transform("Opacity").expressionEnabled = true;
    const s = A.layeropsRead({ comp_id: comp.id, scan_expressions: true });
    expect(s.layers.map((l: any) => [l.index, l.name, l.kind])).toEqual([
      [1, "Ctrl", "solid"],
      [2, "Logo", "solid"],
      [3, "BG", "solid"],
    ]);
    expect(s.layers[1]).toMatchObject({ parent: 1, parent_id: layer(comp, "Ctrl").id, label: 5, shy: false, blendMode: "normal", quality: "best", samplingQuality: "bilinear" });
    expect(s.expressions).toHaveLength(1);
    expect(s.expressions[0]).toMatchObject({ layer_name: "Logo", path: "Transform > Opacity", text: "thisComp.layer(3).transform.opacity", enabled: true });
    expect(s.expressions_truncated).toBe(false);
    expect(A.layeropsRead({ comp_id: comp.id }).expressions).toBeUndefined();
    expect(undo.begun).toBe(0);
  });

  it("reads the destination comp alongside", () => {
    const { project, comp, A } = scene(["A"]);
    const other = project.addComp("Other", 100, 100, 2);
    expect(A.layeropsRead({ comp_id: comp.id, with_comp_id: other.id }).with_comp).toMatchObject({ comp_id: other.id, numLayers: 0 });
  });
});

describe("layerops.jsx: guard, validation and undo", () => {
  it("refuses on a guard mismatch before touching anything", () => {
    const { comp, A } = scene(["A", "B"]);
    expect(() => A.layeropsApply({ action: "delete", comp_id: comp.id, layers: sel("A"), expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(comp.numLayers).toBe(2);
  });

  it("validates before opening an undo group", () => {
    const { comp, A, undo } = scene(["A", "B"]);
    const call = (v: object) => A.layeropsApply({ comp_id: comp.id, expect: GUARD, ...v });
    expect(() => call({ action: "delete" })).toThrow(/layers or a where/);
    expect(() => call({ action: "delete", layers: sel("Nope") })).toThrow(/No layer named/);
    expect(() => call({ action: "parent", layers: sel("A") })).toThrow(/parent/);
    expect(() => call({ action: "reorder", layers: sel("A"), move_to: "before" })).toThrow(/relative_to/);
    expect(() => call({ action: "reorder", layers: sel("A"), move_to: "before", relative_to: { name: "A" } })).toThrow(/being moved/);
    expect(() => call({ action: "sort", sort_by: "colour" })).toThrow(/Unknown sort_by/);
    expect(() => call({ action: "trim", layers: sel("A") })).toThrow(/needs in_point/);
    expect(() => call({ action: "trim", layers: sel("A"), in_point: 1e9 })).toThrow(/within/);
    expect(() => call({ action: "rename", layers: sel("A") })).toThrow(/find/);
    expect(() => call({ action: "rename", layers: sel("A"), template: "x", number_pad: 20 })).toThrow(/number_pad/);
    expect(() => call({ action: "switches", layers: sel("A") })).toThrow(/at least one/);
    expect(() => call({ action: "switches", layers: sel("A"), blend_mode: "sparkle" })).toThrow(/no blend mode/);
    expect(() => call({ action: "switches", layers: sel("A"), label_color: 99 })).toThrow(/label_color/);
    expect(() => call({ action: "explode", layers: sel("A") })).toThrow(/Unknown action/);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(2);
  });

  it("one undo group per write, none for a dry run or a no-op", () => {
    const { comp, A, undo } = scene(["A", "B"]);
    A.layeropsPlan({ action: "delete", comp_id: comp.id, layers: sel("A") });
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(2);
    const noop = A.layeropsApply({ action: "reorder", comp_id: comp.id, layers: sel("A"), move_to: "beginning", expect: GUARD });
    expect(noop.no_op).toBe(true);
    expect(undo.begun).toBe(0);
    A.layeropsApply({ action: "delete", comp_id: comp.id, layers: sel("A"), expect: GUARD });
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });
});

describe("layerops.jsx: parent", () => {
  it("parents with keep_position by assigning layer.parent, and jumps only on request", () => {
    const { comp, A } = scene(["Ctrl", "Logo", "Text"]);
    const r = A.layeropsApply({ action: "parent", comp_id: comp.id, layers: sel("Logo", "Text"), parent: { name: "Ctrl" }, expect: GUARD });
    expect(r.mode).toBe("keep_position");
    expect(r.applied_ids).toHaveLength(2);
    expect(layer(comp, "Logo").parent).toBe(layer(comp, "Ctrl"));
    expect(layer(comp, "Logo").jumps).toBe(0);
    A.layeropsApply({ action: "parent", comp_id: comp.id, layers: sel("Text"), unparent: true, expect: GUARD });
    expect(layer(comp, "Text").parent).toBe(null);
    const j = A.layeropsApply({ action: "parent", comp_id: comp.id, layers: sel("Text"), parent: { name: "Logo" }, keep_position: false, expect: GUARD });
    expect(j.mode).toBe("jump");
    expect(j.warnings.join(" ")).toContain("jump");
    expect(layer(comp, "Text").jumps).toBe(1);
    expect(layer(comp, "Text").parent).toBe(layer(comp, "Logo"));
  });

  it("skips itself, loops and layers already parented, and says why", () => {
    const { comp, A } = scene(["Top", "Mid", "Low"]);
    layer(comp, "Mid").parent = layer(comp, "Top");
    layer(comp, "Low").parent = layer(comp, "Mid");
    const plan = A.layeropsPlan({ action: "parent", comp_id: comp.id, layers: sel("Top", "Mid", "Low"), parent: { name: "Low" } });
    const reasons = Object.fromEntries(plan.skipped.map((s: any) => [s.name, s.reason]));
    expect(reasons.Low).toContain("own parent");
    expect(reasons.Top).toContain("loop");
    expect(reasons.Mid).toContain("loop");
    expect(plan.would_change).toBe(0);
    const un = A.layeropsPlan({ action: "parent", comp_id: comp.id, layers: sel("Top"), unparent: true });
    expect(un.skipped[0].reason).toContain("no parent");
  });

  it("reports a layer AE refuses and carries on", () => {
    const { comp, A } = scene(["Ctrl", "A", "B"]);
    Object.defineProperty(layer(comp, "A"), "parent", {
      get: () => null,
      set: () => {
        throw new Error("nope");
      },
    });
    const r = A.layeropsApply({ action: "parent", comp_id: comp.id, layers: sel("A", "B"), parent: { name: "Ctrl" }, expect: GUARD });
    expect(r.applied_ids).toEqual([layer(comp, "B").id]);
    expect(r.skipped[0].reason).toContain("AE refused: nope");
  });
});

describe("layerops.jsx: reorder and sort", () => {
  it("moves layers to the beginning, end, before and after, in the fewest moves", () => {
    const { comp, A } = scene(["A", "B", "C", "D"]);
    const go = (v: object) => A.layeropsApply({ action: "reorder", comp_id: comp.id, expect: GUARD, ...v });
    expect(go({ layers: sel("D"), move_to: "beginning" }).moves).toBe(1);
    expect(order(comp)).toEqual(["D", "A", "B", "C"]);
    expect(go({ layers: sel("D"), move_to: "end" }).moves).toBe(1);
    expect(order(comp)).toEqual(["A", "B", "C", "D"]);
    go({ layers: sel("A", "B"), move_to: "end" });
    expect(order(comp)).toEqual(["C", "D", "A", "B"]);
    go({ layers: sel("D"), move_to: "before", relative_to: { name: "B" } });
    expect(order(comp)).toEqual(["C", "A", "D", "B"]);
    const r = go({ layers: sel("C"), move_to: "after", relative_to: { name: "D" } });
    expect(order(comp)).toEqual(["A", "D", "C", "B"]);
    expect(r.order_after).toEqual(comp.stack.map((l) => l.id));
  });

  it("keeps the selected layers' order among themselves", () => {
    const { comp, A } = scene(["A", "B", "C", "D"]);
    A.layeropsApply({ action: "reorder", comp_id: comp.id, layers: sel("D", "B"), move_to: "beginning", expect: GUARD });
    expect(order(comp)).toEqual(["B", "D", "A", "C"]);
  });

  it("reports an already-in-place reorder as a no-op", () => {
    const { comp, A } = scene(["A", "B"]);
    const p = A.layeropsPlan({ action: "reorder", comp_id: comp.id, layers: sel("A"), move_to: "beginning" });
    expect(p.would_change).toBe(0);
    expect(p.warnings.join(" ")).toContain("already");
  });

  it("sorts by natural name, descending, and a subset in its own slots", () => {
    const { comp, A } = scene(["Layer 10", "layer 2", "Layer 1"]);
    A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "name", expect: GUARD });
    expect(order(comp)).toEqual(["Layer 1", "layer 2", "Layer 10"]);
    A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "name", descending: true, expect: GUARD });
    expect(order(comp)).toEqual(["Layer 10", "layer 2", "Layer 1"]);
    const sub = scene(["Zed", "Mid", "Alpha"]);
    sub.A.layeropsApply({ action: "sort", comp_id: sub.comp.id, layers: [{ index: 1 }, { index: 3 }], sort_by: "name", expect: GUARD });
    expect(order(sub.comp)).toEqual(["Alpha", "Mid", "Zed"]);
  });

  it("sorts by start time, in point, z and label", () => {
    const { comp, A } = scene(["a", "b", "c"]);
    layer(comp, "a").startTime = 3;
    layer(comp, "b").startTime = 1;
    layer(comp, "c").startTime = 2;
    A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "start_time", expect: GUARD });
    expect(order(comp)).toEqual(["b", "c", "a"]);
    layer(comp, "a").inPoint = 0.5;
    layer(comp, "b").inPoint = 2;
    layer(comp, "c").inPoint = 1;
    A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "in_point", descending: true, expect: GUARD });
    expect(order(comp)).toEqual(["b", "c", "a"]);
    layer(comp, "a").transform("Position").setValue([0, 0, 300]);
    layer(comp, "b").transform("Position").setValue([0, 0, -50]);
    layer(comp, "c").transform("Position").setValue([0, 0, 100]);
    A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "z", expect: GUARD });
    expect(order(comp)).toEqual(["b", "c", "a"]);
    layer(comp, "a").label = 2;
    layer(comp, "b").label = 9;
    layer(comp, "c").label = 2;
    A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "label", expect: GUARD });
    // Ties keep their current order (b was above c above a; a and c share label 2).
    expect(order(comp)).toEqual(["c", "a", "b"]);
  });

  it("gets any permutation right with the planned moves", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 40; round++) {
      const n = 2 + (rnd() % 14);
      const names = Array.from({ length: n }, (_, i) => `L${i}`);
      const { comp, A } = scene(names);
      const labels = names.map(() => rnd() % 17);
      names.forEach((nm, i) => (layer(comp, nm).label = labels[i]));
      const want = names
        .map((nm, i) => ({ nm, i, label: labels[i]! }))
        .sort((a, b) => a.label - b.label || a.i - b.i)
        .map((x) => x.nm);
      const r = A.layeropsApply({ action: "sort", comp_id: comp.id, sort_by: "label", expect: GUARD });
      expect(order(comp)).toEqual(want);
      expect(r.moves).toBeLessThan(n);
    }
  });

  it("moves only the layers that must move, so a locked bystander needs no unlock", () => {
    const { comp, A } = scene(["A", "B", "C", "D"]);
    layer(comp, "B").locked = true;
    const r = A.layeropsApply({ action: "reorder", comp_id: comp.id, layers: sel("D"), move_to: "beginning", expect: GUARD });
    expect(r.locked).toEqual([]);
    expect(layer(comp, "B").locked).toBe(true);
  });
});

describe("layerops.jsx: locked layers", () => {
  it("refuses to edit a locked layer unless told to unlock, then relocks it", () => {
    const { comp, A, undo } = scene(["A", "B"]);
    layer(comp, "B").locked = true;
    expect(() => A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("B"), template: "New", expect: GUARD })).toThrow(/locked layer/);
    expect(layer(comp, "B").name).toBe("B");
    expect(undo.begun).toBe(0);
    const plan = A.layeropsPlan({ action: "rename", comp_id: comp.id, layers: sel("B"), template: "New" });
    expect(plan.locked.map((x: any) => x.name)).toEqual(["B"]);
    expect(plan.warnings.join(" ")).toContain("unlock_locked");
    const r = A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("B"), template: "New", unlock_locked: true, expect: GUARD });
    expect(layer(comp, "New").locked).toBe(true);
    expect(r.unlocked).toHaveLength(1);
    expect(r.relocked).toEqual(r.unlocked);
  });
});

describe("layerops.jsx: duplicate", () => {
  it("duplicates in place, several times, and says where the copies went", () => {
    const { comp, A } = scene(["A", "B"]);
    const r = A.layeropsApply({ action: "duplicate", comp_id: comp.id, layers: sel("B"), count: 2, expect: GUARD });
    expect(order(comp)).toEqual(["A", "B", "B", "B"]);
    expect(r.duplicates).toHaveLength(2);
    expect(r.order_after).toHaveLength(4);
    const p = A.layeropsPlan({ action: "duplicate", comp_id: comp.id, layers: sel("A") });
    expect(p.order_after[0]).toBe(null);
  });

  it("copies into another comp with copyToComp and finds the new layer by id", () => {
    const { project, comp, A } = scene(["A", "B"]);
    const other = project.addComp("Other", 100, 100, 2);
    decorate(other.layers.addNull());
    const r = A.layeropsApply({ action: "duplicate", comp_id: comp.id, layers: sel("A", "B"), to_comp_id: other.id, expect: GUARD });
    expect(other.numLayers).toBe(3);
    expect(r.duplicates.map((d: any) => d.name)).toEqual(["B", "A"]);
    expect(order(other).slice(0, 2)).toEqual(["A", "B"]);
    expect(comp.numLayers).toBe(2);
  });

  it("skips a layer whose source is the destination, warns about effects, and reports a refused copy", () => {
    const { project, comp, A } = scene(["A", "B"]);
    const other = project.addComp("Other", 100, 100, 2);
    const pre = decorate(comp.layers.add(other, 2));
    pre.name = "Pre";
    const plan = A.layeropsPlan({ action: "duplicate", comp_id: comp.id, layers: sel("Pre", "A"), to_comp_id: other.id });
    expect(plan.skipped[0].reason).toContain("destination");
    (layer(comp, "A").group.property("ADBE Effect Parade") as any).props.push({ name: "Blur", propertyType: 6812 });
    expect(A.layeropsPlan({ action: "duplicate", comp_id: comp.id, layers: sel("A"), to_comp_id: other.id }).warnings.join(" ")).toContain("copyToComp");
    layer(comp, "B").refuseCopy = true;
    const r = A.layeropsApply({ action: "duplicate", comp_id: comp.id, layers: sel("A", "B"), to_comp_id: other.id, expect: GUARD });
    expect(r.duplicates).toHaveLength(1);
    expect(r.skipped[0].reason).toContain("cannot copy");
  });

  it("refuses a count above 1 with copyToComp", () => {
    const { project, comp, A } = scene(["A"]);
    const other = project.addComp("Other", 100, 100, 2);
    expect(() => A.layeropsPlan({ action: "duplicate", comp_id: comp.id, layers: sel("A"), to_comp_id: other.id, count: 2 })).toThrow(/same comp only/);
    expect(() => A.layeropsPlan({ action: "duplicate", comp_id: comp.id, layers: sel("A"), count: 0 })).toThrow(/count/);
  });
});

describe("layerops.jsx: delete", () => {
  it("deletes the layers and lists the children and matte users left behind", () => {
    const { comp, A } = scene(["Ctrl", "Child", "Plate", "Other"]);
    layer(comp, "Child").parent = layer(comp, "Ctrl");
    layer(comp, "Plate").trackMatteLayer = layer(comp, "Ctrl");
    const plan = A.layeropsPlan({ action: "delete", comp_id: comp.id, layers: sel("Ctrl") });
    expect(plan.orphaned_children.map((c: any) => c.name)).toEqual(["Child"]);
    expect(plan.matte_dependents.map((c: any) => c.name)).toEqual(["Plate"]);
    expect(comp.numLayers).toBe(4);
    const r = A.layeropsApply({ action: "delete", comp_id: comp.id, layers: sel("Ctrl", "Other"), expect: GUARD });
    expect(order(comp)).toEqual(["Child", "Plate"]);
    expect(r.deleted.map((d: any) => d.name)).toEqual(["Other", "Ctrl"]);
    expect(r.order_after).toEqual(comp.stack.map((l) => l.id));
  });

  it("deletes a locked layer only with unlock_locked", () => {
    const { comp, A } = scene(["A", "B"]);
    layer(comp, "A").locked = true;
    expect(() => A.layeropsApply({ action: "delete", comp_id: comp.id, layers: sel("A"), expect: GUARD })).toThrow(/locked/);
    A.layeropsApply({ action: "delete", comp_id: comp.id, layers: sel("A"), unlock_locked: true, expect: GUARD });
    expect(order(comp)).toEqual(["B"]);
  });

  it("deletes with unlock_locked without throwing, though a removed layer is invalid", () => {
    const { comp, A } = scene(["A", "B"]);
    const a = layer(comp, "A");
    a.locked = true;
    const id = a.id;
    const realRemove = a.remove.bind(a);
    a.remove = () => {
      realRemove();
      // Like AE: every property of a removed layer throws.
      for (const key of ["id", "name", "locked", "index"]) {
        Object.defineProperty(a, key, {
          configurable: true,
          get() {
            throw new Error("Object is invalid");
          },
          set() {
            throw new Error("Object is invalid");
          },
        });
      }
    };
    const r = A.layeropsApply({ action: "delete", comp_id: comp.id, layers: sel("A"), unlock_locked: true, expect: GUARD });
    expect(order(comp)).toEqual(["B"]);
    expect(r.unlocked).toEqual([id]);
    expect(r.relocked).toEqual([]);
    expect(r.deleted_total).toBe(1);
  });

  it("selects by where: every layer with a label", () => {
    const { comp, A } = scene(["A", "B", "C"]);
    layer(comp, "B").label = 4;
    layer(comp, "C").label = 4;
    A.layeropsApply({ action: "delete", comp_id: comp.id, where: { label: 4 }, expect: GUARD });
    expect(order(comp)).toEqual(["A"]);
  });
});

describe("layerops.jsx: trim", () => {
  it("sets in and out points, in an order AE accepts", () => {
    const { comp, A } = scene(["A"]);
    const a = layer(comp, "A");
    a.outPoint = 10;
    A.layeropsApply({ action: "trim", comp_id: comp.id, layers: sel("A"), in_point: 2, out_point: 5, expect: GUARD });
    expect([a.inPoint, a.outPoint]).toEqual([2, 5]);
    // The new in point is past the old out point, so the out point moves first.
    const r = A.layeropsApply({ action: "trim", comp_id: comp.id, layers: sel("A"), in_point: 8, out_point: 9, expect: GUARD });
    expect([a.inPoint, a.outPoint]).toEqual([8, 9]);
    expect(r.trims[0]).toMatchObject({ in_point: 8, out_point: 9 });
  });

  it("moves the start time with the in and out points, then applies explicit points", () => {
    const { comp, A } = scene(["A"]);
    const a = layer(comp, "A");
    a.outPoint = 4;
    A.layeropsApply({ action: "trim", comp_id: comp.id, layers: sel("A"), start_time: 3, expect: GUARD });
    expect([a.startTime, a.inPoint, a.outPoint]).toEqual([3, 3, 7]);
    A.layeropsApply({ action: "trim", comp_id: comp.id, layers: sel("A"), start_time: 1, out_point: 2, expect: GUARD });
    expect([a.startTime, a.inPoint, a.outPoint]).toEqual([1, 1, 2]);
  });

  it("skips a layer whose in point would pass its out point", () => {
    const { comp, A } = scene(["A", "B"]);
    layer(comp, "B").outPoint = 20;
    const r = A.layeropsApply({ action: "trim", comp_id: comp.id, layers: sel("A", "B"), in_point: 12, expect: GUARD });
    expect(r.skipped[0]).toMatchObject({ name: "A" });
    expect(r.skipped[0].reason).toContain("before the out point");
    expect(layer(comp, "B").inPoint).toBe(12);
    expect(layer(comp, "A").inPoint).toBe(0);
  });
});

describe("layerops.jsx: rename", () => {
  it("finds and replaces every occurrence, case-insensitively unless asked", () => {
    const { comp, A } = scene(["Title", "title Shadow", "BG"]);
    const r = A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("Title", "title Shadow", "BG"), find: "title", replace: "Head", expect: GUARD });
    expect(order(comp)).toEqual(["Head", "Head Shadow", "BG"]);
    expect(r.renames.map((x: any) => [x.from, x.to])).toEqual([["Title", "Head"], ["title Shadow", "Head Shadow"]]);
    expect(r.skipped[0]).toMatchObject({ name: "BG", reason: "the name would not change" });
    const cs = scene(["Title", "title"]);
    cs.A.layeropsApply({ action: "rename", comp_id: cs.comp.id, where: { name_contains: "TITLE" }, find: "title", replace: "T", case_sensitive: true, expect: GUARD });
    expect(order(cs.comp)).toEqual(["Title", "T"]);
  });

  it("treats find as literal text, not a pattern", () => {
    const { comp, A } = scene(["a.b", "axb", "c$&d"]);
    A.layeropsApply({ action: "rename", comp_id: comp.id, where: { has_parent: false }, find: ".", replace: "$&", expect: GUARD });
    expect(order(comp)).toEqual(["a$&b", "axb", "c$&d"]);
  });

  it("numbers with a padded counter over the layers in stack order, and {index}", () => {
    const { comp, A } = scene(["x", "y", "z"]);
    A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("z", "x", "y"), template: "Row {n}", start_number: 5, number_pad: 3, expect: GUARD });
    expect(order(comp)).toEqual(["Row 005", "Row 006", "Row 007"]);
    A.layeropsApply({ action: "rename", comp_id: comp.id, where: { has_parent: false }, template: "{index}_{name}", number_pad: 2, expect: GUARD });
    expect(order(comp)).toEqual(["01_Row 005", "02_Row 006", "03_Row 007"]);
  });

  it("skips names that would be empty or too long, and warns about shared names", () => {
    const { comp, A } = scene(["a", "b"]);
    const p = A.layeropsPlan({ action: "rename", comp_id: comp.id, layers: sel("a"), find: "a", replace: "" });
    expect(p.skipped[0].reason).toContain("empty");
    const long = A.layeropsPlan({ action: "rename", comp_id: comp.id, layers: sel("a"), find: "a", replace: new Array(202).join("x") });
    expect(long.skipped[0].reason).toContain("longer than");
    const dup = A.layeropsPlan({ action: "rename", comp_id: comp.id, layers: sel("a"), find: "a", replace: "b" });
    expect(dup.warnings.join(" ")).toContain("shared by several layers");
  });

  it("repairs name references with autoFixExpressions only when asked", () => {
    const { project, comp, A } = scene(["Title", "BG"]);
    const fixes: string[][] = [];
    (project as any).autoFixExpressions = (a: string, b: string) => fixes.push([a, b]);
    A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("Title"), find: "Title", replace: "Head", expect: GUARD });
    expect(fixes).toEqual([]);
    const r = A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("Head"), find: "Head", replace: 'He"ad', fix_name_references: true, expect: GUARD });
    expect(fixes).toEqual([['"Head"', '"He\\"ad"']]);
    expect(r.name_fixes_attempted).toBe(1);
  });

  it("says so when this AE has no autoFixExpressions", () => {
    const { comp, A } = scene(["Title"]);
    const r = A.layeropsApply({ action: "rename", comp_id: comp.id, layers: sel("Title"), find: "Title", replace: "T", fix_name_references: true, expect: GUARD });
    expect(r.warnings.join(" ")).toContain("autoFixExpressions");
    expect(r.name_fixes_attempted).toBe(0);
  });
});

describe("layerops.jsx: switches", () => {
  function rig() {
    const s = scene(["Cam", "Fx", "Pre", "Voice"]);
    const { project, comp } = s;
    const cam = decorate(new FakeLayer(comp, "Cam", "CameraLayer"));
    const inner = project.addComp("Inner", 100, 100, 2);
    const pre = decorate(comp.layers.add(inner, 2));
    pre.name = "Pre";
    comp.stack = [cam, comp.stack.find((l) => l.name === "Fx")!, pre, comp.stack.find((l) => l.name === "Voice")!];
    (layer(comp, "Voice") as any).hasVideo = false;
    return s;
  }

  it("sets switches, skipping layers a switch does not fit and saying why", () => {
    const { comp, A } = rig();
    const r = A.layeropsApply({
      action: "switches",
      comp_id: comp.id,
      layers: sel("Cam", "Fx", "Pre", "Voice"),
      shy: true,
      three_d: true,
      motion_blur: true,
      collapse_transformations: true,
      blend_mode: "multiply",
      quality: "draft",
      sampling_quality: "bicubic",
      label_color: 7,
      guide: true,
      expect: GUARD,
    });
    const fx = layer(comp, "Fx");
    expect([fx.shy, fx.threeDLayer, fx.motionBlur, fx.blendingMode, fx.quality, fx.samplingQuality, fx.label, fx.guideLayer]).toEqual([true, true, true, BM.MULTIPLY, LQ.DRAFT, LS.BICUBIC, 7, true]);
    expect(fx.collapseTransformation).toBe(false);
    expect(layer(comp, "Pre").collapseTransformation).toBe(true);
    const skipped = r.skipped.map((s: any) => `${s.name}:${s.key}`);
    expect(skipped).toContain("Cam:three_d");
    expect(skipped).toContain("Cam:motion_blur");
    expect(skipped).toContain("Cam:blend_mode");
    expect(skipped).toContain("Fx:collapse_transformations");
    expect(skipped).toContain("Voice:three_d");
    expect(skipped).toContain("Voice:blend_mode");
    expect(layer(comp, "Cam").shy).toBe(true);
    expect(layer(comp, "Voice").shy).toBe(true);
    expect(layer(comp, "Cam").label).toBe(7);
    expect(r.changes.every((c: any) => c.id && c.key)).toBe(true);
  });

  it("counts layers already in the wanted state as unchanged, not as work", () => {
    const { comp, A, undo } = scene(["A", "B"]);
    layer(comp, "A").shy = true;
    const r = A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A"), shy: true, expect: GUARD });
    expect(r.unchanged).toBe(1);
    expect(r.no_op).toBe(true);
    expect(undo.begun).toBe(0);
  });

  it("does not ask for unlock_locked when the same call unlocks the layer", () => {
    const { comp, A } = scene(["A"]);
    layer(comp, "A").locked = true;
    A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A"), locked: false, solo: true, expect: GUARD });
    expect(layer(comp, "A").solo).toBe(true);
    expect(layer(comp, "A").locked).toBe(false);
  });

  it("finds the silhouette alpha blend mode under either spelling", () => {
    const one = scene(["A"]);
    (one.G as any).BlendingMode = { ...BM, SILHOUETE_ALPHA: 9 };
    one.A.layeropsApply({ action: "switches", comp_id: one.comp.id, layers: sel("A"), blend_mode: "silhouette_alpha", expect: GUARD });
    expect(layer(one.comp, "A").blendingMode).toBe(9);
    const two = scene(["A"]);
    (two.G as any).BlendingMode = { ...BM, SILHOUETTE_ALPHA: 8 };
    two.A.layeropsApply({ action: "switches", comp_id: two.comp.id, layers: sel("A"), blend_mode: "silhouette_alpha", expect: GUARD });
    expect(layer(two.comp, "A").blendingMode).toBe(8);
    expect(two.A.layeropsRead({ comp_id: two.comp.id }).layers[0].blendMode).toBe("silhouette_alpha");
  });

  it("edits a locked layer only with unlock_locked, and leaves it locked unless locked is set", () => {
    const { comp, A } = scene(["A", "B"]);
    layer(comp, "A").locked = true;
    expect(() => A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A"), solo: true, expect: GUARD })).toThrow(/locked/);
    const r = A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A"), solo: true, unlock_locked: true, expect: GUARD });
    expect(layer(comp, "A").solo).toBe(true);
    expect(layer(comp, "A").locked).toBe(true);
    expect(r.unlocked).toHaveLength(1);
    expect(r.relocked).toHaveLength(1);
    // Changing the lock itself needs no unlock.
    A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A"), locked: false, expect: GUARD });
    expect(layer(comp, "A").locked).toBe(false);
    A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A", "B"), locked: true, enabled: false, expect: GUARD });
    expect(layer(comp, "B").locked).toBe(true);
    expect(layer(comp, "B").enabled).toBe(false);
  });

  it("selects with where and is read back by a separate read", () => {
    const { comp, A } = scene(["A", "B", "C"]);
    layer(comp, "B").label = 3;
    A.layeropsApply({ action: "switches", comp_id: comp.id, where: { label: 3 }, shy: true, expect: GUARD });
    const s = A.layeropsRead({ comp_id: comp.id });
    expect(s.layers.map((l: any) => l.shy)).toEqual([false, true, false]);
  });

  it("reports a switch AE throws on without losing the others", () => {
    const { comp, A } = scene(["A"]);
    Object.defineProperty(layer(comp, "A"), "motionBlur", {
      get: () => false,
      set: () => {
        throw new Error("no blur here");
      },
    });
    const r = A.layeropsApply({ action: "switches", comp_id: comp.id, layers: sel("A"), motion_blur: true, shy: true, expect: GUARD });
    expect(layer(comp, "A").shy).toBe(true);
    expect(r.skipped).toEqual([expect.objectContaining({ key: "motion_blur", reason: "AE refused: no blur here" })]);
    expect(r.changes.map((c: any) => c.key)).toEqual(["shy"]);
  });
});
