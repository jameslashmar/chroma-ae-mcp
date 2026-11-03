import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeCreateLayerSchema,
  AePrecomposeSchema,
  AeSetTrackMatteSchema,
  createLayerMismatches,
  layersTools,
  precomposeMismatches,
  resolveInStack,
  trackMatteMismatches,
  type LayerStack,
  type StackLayer,
} from "../src/tools/ext/layers.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => layersTools.find((t) => t.name === name)!;

/** A PanelHost whose AE answers from a script of results, recording each call and its args. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-layers-q-"));
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

const L = (index: number, id: number, name: string, extra: Partial<StackLayer> = {}): StackLayer => ({
  index,
  id,
  name,
  kind: "solid",
  enabled: true,
  parent: null,
  trackMatte: { type: "none", layer: null },
  ...extra,
});

const stack = (layers: StackLayer[], extra: Partial<LayerStack> = {}): LayerStack => ({
  comp_id: 1,
  name: "Main",
  numLayers: layers.length,
  layers,
  ...extra,
});

const expectArg = { project_path: "<unsaved>" };

describe("layer tools", () => {
  it("are registered and take automatic checkpoints", () => {
    for (const name of ["ae_create_layer", "ae_precompose", "ae_set_track_matte"]) {
      expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
      expect(AUTO_CHECKPOINT_TOOLS).toContain(name);
    }
  });

  it("ae_create_layer guards, reads, writes, and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      layerStack: [stack([L(1, 10, "BG")]), stack([L(1, 11, "Ctrl", { kind: "null" }), L(2, 10, "BG")])],
      createLayer: [{ index: 1, id: 11, name: "Ctrl", kind: "null" }],
    });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "null", name: "Ctrl", expect: expectArg });
    const out = await tool("ae_create_layer").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "layerStack", "createLayer", "layerStack"]);
    expect(calls[2].script).toContain('"expect"');
    expect(out.receipt.matches).toBe(true);
    expect(out.layer).toMatchObject({ id: 11, name: "Ctrl", kind: "null" });
  });

  it("ae_create_layer schema needs item_id for footage and precomp, and one placement", () => {
    expect(AeCreateLayerSchema.safeParse({ comp_id: 1, type: "precomp", expect: expectArg }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ comp_id: 1, type: "precomp", item_id: 5, expect: expectArg }).success).toBe(true);
    expect(
      AeCreateLayerSchema.safeParse({ comp_id: 1, type: "null", placement: { index: 2, bottom: true }, expect: expectArg }).success
    ).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ comp_id: 1, type: "null", placement: { bottom: true }, expect: expectArg }).success).toBe(true);
  });

  it("ae_precompose refuses leaving attributes for several layers before touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    const args = AePrecomposeSchema.parse({ comp_id: 1, layers: [{ index: 1 }, { index: 2 }], move_all_attributes: false, expect: expectArg });
    const out = await tool("ae_precompose").handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });

  it("ae_precompose reads the new comp back with the outer one", async () => {
    const { ctx, calls } = fakeAe({
      layerStack: [
        stack([L(1, 10, "Title", { kind: "text" }), L(2, 11, "Glow"), L(3, 12, "BG")]),
        stack([L(1, 20, "Pre-comp 1", { kind: "precomp", sourceId: 99 }), L(2, 12, "BG")], {
          with_comp: stack([L(1, 30, "Title", { kind: "text" }), L(2, 31, "Glow")], { comp_id: 99, name: "Pre-comp 1" }),
        }),
      ],
      precomposeLayers: [{ new_comp_id: 99, new_comp_name: "Pre-comp 1", layer_indexes: [1, 2], layer_names: ["Title", "Glow"], move_all_attributes: true }],
    });
    const args = AePrecomposeSchema.parse({ comp_id: 1, layers: [{ name: "Glow" }, { index: 1 }], expect: expectArg });
    const out = await tool("ae_precompose").handler(args, ctx);
    expect(calls[3].script).toContain('"with_comp_id":99');
    expect(out.receipt.matches).toBe(true);
    expect(out.precomp_layer).toMatchObject({ index: 1, sourceId: 99 });
    expect(out.new_comp.layers.map((l: { name: string }) => l.name)).toEqual(["Title", "Glow"]);
  });

  it("ae_set_track_matte needs a matte unless removing", () => {
    expect(AeSetTrackMatteSchema.safeParse({ comp_id: 1, layer: { index: 2 }, type: "alpha", expect: expectArg }).success).toBe(false);
    expect(AeSetTrackMatteSchema.safeParse({ comp_id: 1, layer: { index: 2 }, type: "none", expect: expectArg }).success).toBe(true);
  });
});

describe("resolveInStack", () => {
  const s = stack([L(1, 10, "A"), L(2, 11, "B"), L(3, 12, "B")]);
  it("finds by id, index, or a unique name", () => {
    expect(resolveInStack(s, { id: 11 })?.index).toBe(2);
    expect(resolveInStack(s, { index: 1 })?.id).toBe(10);
    expect(resolveInStack(s, { name: "A" })?.id).toBe(10);
    expect(resolveInStack(s, { name: "B" })).toBeUndefined();
  });
});

describe("createLayerMismatches", () => {
  const before = stack([L(1, 10, "Logo"), L(2, 11, "BG")]);

  it("accepts a layer placed below its reference", () => {
    const after = stack([L(1, 10, "Logo"), L(2, 12, "Shadow"), L(3, 11, "BG")]);
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "solid", name: "Shadow", placement: { below: { name: "Logo" } }, expect: expectArg });
    expect(createLayerMismatches(args, before, after, { id: 12 })).toEqual([]);
  });

  it("flags a layer left at the top when asked for the bottom", () => {
    const after = stack([L(1, 12, "Shadow"), L(2, 10, "Logo"), L(3, 11, "BG")]);
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "solid", placement: { bottom: true }, expect: expectArg });
    expect(createLayerMismatches(args, before, after, { id: 12 }).map((m) => m.path)).toEqual(["layer.index"]);
  });

  it("checks the parent by id across the index shift", () => {
    const after = stack([L(1, 12, "Ctrl", { kind: "null", parent: 2 }), L(2, 10, "Logo"), L(3, 11, "BG")]);
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "null", name: "Ctrl", parent: { index: 1 }, expect: expectArg });
    expect(createLayerMismatches(args, before, after, { id: 12 })).toEqual([]);
  });

  it("compares text with AE's \\r line breaks", () => {
    const after = stack([L(1, 12, "Hi", { kind: "text", text: "Hello\rWorld" }), L(2, 10, "Logo"), L(3, 11, "BG")]);
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "text", text: "Hello\nWorld", expect: expectArg });
    expect(createLayerMismatches(args, before, after, { id: 12 })).toEqual([]);
  });

  it("flags a wrong kind and a missing adjustment switch", () => {
    const after = stack([L(1, 12, "Adj"), L(2, 10, "Logo"), L(3, 11, "BG")]);
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "adjustment", name: "Adj", expect: expectArg });
    expect(createLayerMismatches(args, before, after, { id: 12 }).map((m) => m.path)).toEqual(["layer.kind", "layer.adjustment"]);
  });
});

describe("precomposeMismatches", () => {
  it("flags a new comp whose layers are out of order", () => {
    const before = stack([L(1, 10, "A"), L(2, 11, "B")]);
    const after = stack([L(1, 20, "Pre-comp 1", { sourceId: 99 })], { with_comp: stack([L(1, 31, "B"), L(2, 30, "A")]) });
    const m = precomposeMismatches(before, after, { new_comp_id: 99, layer_indexes: [1, 2], layer_names: ["A", "B"] });
    expect(m.map((x) => x.path)).toEqual(["new_comp.layers"]);
  });
});

describe("trackMatteMismatches", () => {
  const base = { comp_id: 1, layer: { index: 3 }, expect: expectArg };

  it("accepts a matte set from a layer that isn't directly above, with the matte hidden", () => {
    const before = stack([L(1, 10, "Mask"), L(2, 11, "Other"), L(3, 12, "Plate")]);
    const after = stack([
      L(1, 10, "Mask", { enabled: false, isTrackMatte: true }),
      L(2, 11, "Other"),
      L(3, 12, "Plate", { trackMatte: { type: "luma", layer: { index: 1, id: 10, name: "Mask" } } }),
    ]);
    const args = AeSetTrackMatteSchema.parse({ ...base, type: "luma", matte: { index: 1 } });
    expect(trackMatteMismatches(args, before, after, { layer: { id: 12 }, matte: { id: 10 } })).toEqual([]);
  });

  it("flags a matte left visible and another layer's matte changing", () => {
    const before = stack([L(1, 10, "Mask"), L(2, 11, "Other"), L(3, 12, "Plate")]);
    const after = stack([
      L(1, 10, "Mask"),
      L(2, 11, "Other", { trackMatte: { type: "alpha", layer: { index: 1, id: 10, name: "Mask" } } }),
      L(3, 12, "Plate", { trackMatte: { type: "alpha", layer: { index: 1, id: 10, name: "Mask" } } }),
    ]);
    const args = AeSetTrackMatteSchema.parse({ ...base, type: "alpha", matte: { index: 1 } });
    expect(trackMatteMismatches(args, before, after, { layer: { id: 12 }, matte: { id: 10 } }).map((m) => m.path)).toEqual([
      "matte.enabled",
      "layers[2].trackMatte",
    ]);
  });

  it("checks the old matte comes back on when removing with show_matte", () => {
    const after = stack([L(1, 10, "Mask", { enabled: false }), L(2, 12, "Plate")]);
    const args = AeSetTrackMatteSchema.parse({ ...base, type: "none", show_matte: true });
    expect(trackMatteMismatches(args, after, after, { layer: { id: 12 }, previous_matte: { id: 10 } }).map((m) => m.path)).toEqual([
      "previous_matte.enabled",
    ]);
  });
});
