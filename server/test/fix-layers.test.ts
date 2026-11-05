/**
 * Regression tests for the layer-group review fixes: the write runner never
 * throws once the write is applied, createLayer validates before it adds and
 * rolls back, footage/precomp layers are trimmed and checked, lightType only
 * shows on lights, camera and light layers are refused as mattes, and the
 * receipts cope with comps past the 500-layer cap.
 */

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
  trackMatteMismatches,
  type LayerStack,
  type StackLayer,
} from "../src/tools/ext/layers.js";
import { FakeProject, GUARD, loadHost, TrackMatteType, type FakeComp, type FakeLayer } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => layersTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results; an empty list makes that call fail. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fixlayers-q-"));
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

function scene(dur = 10) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, dur);
  return { project, comp };
}

/** Gives a fake layer the remove() the real AE has. */
function removable(l: FakeLayer): FakeLayer {
  (l as any).remove = () => {
    l.comp.stack = l.comp.stack.filter((x) => x !== l);
  };
  return l;
}

describe("write runner after a committed write (C20, C21)", () => {
  it("returns applied:true with a read_back mismatch when the after-read fails", async () => {
    const { ctx, calls } = fakeAe({
      // Only the before-read has an answer: the after-read rejects.
      layerStack: [stack([L(1, 10, "BG")])],
      createLayer: [{ index: 1, id: 11, name: "Ctrl", kind: "null" }],
    });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "null", name: "Ctrl", expect: expectArg });
    const out = await tool("ae_create_layer").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "layerStack", "createLayer", "layerStack"]);
    expect(out.applied).toBe(true);
    expect(out.op_id).toBeTruthy();
    expect(out).toMatchObject({ id: 11, name: "Ctrl" });
    expect(out.receipt.matches).toBe(false);
    const rb = out.receipt.mismatches.find((x: { path: string }) => x.path === "read_back");
    expect(rb.message).toMatch(/applied/);
    expect(rb.message).toMatch(/Do not resend/);
  });

  it("returns applied:true when the check callback throws", async () => {
    const { ctx } = fakeAe({
      layerStack: [stack([L(1, 10, "BG")]), { numLayers: 2, layers: null }],
      createLayer: [{ index: 1, id: 11, name: "Ctrl", kind: "null" }],
    });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "null", name: "Ctrl", expect: expectArg });
    const out = await tool("ae_create_layer").handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((x: { path: string }) => x.path === "read_back")).toBe(true);
  });
});

describe("createLayer host (C17, C16, C18)", () => {
  it("validates before adding: bad duration, color, light type and a 3D audio layer", () => {
    const { project, comp } = scene();
    const audio = project.addFootage("vo.wav", 0, 0);
    (audio as any).hasVideo = false;
    const { A, undo } = loadHost(project, ["layers.jsx"]);
    const bad = (a: Record<string, unknown>) => () => A.createLayer({ comp_id: comp.id, expect: GUARD, ...a });
    expect(bad({ type: "null", duration: -1 })).toThrow(/duration/);
    expect(bad({ type: "null", start_time: "x" })).toThrow(/start_time/);
    expect(bad({ type: "solid", color: [2, 0, 0] })).toThrow(/color/);
    expect(bad({ type: "light", light_type: "bogus" })).toThrow(/Unknown light type/);
    expect(bad({ type: "bogus" })).toThrow(/Unknown layer type/);
    expect(bad({ type: "footage", item_id: audio.id, three_d: true })).toThrow(/no video/);
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(0);
  });

  it("removes the layer and its solid item when a later step throws, in the same undo group", () => {
    const { project, comp } = scene();
    const orig = comp.layers.addSolid;
    comp.layers.addSolid = (...a: any[]) => {
      const l = removable(orig(...a));
      Object.defineProperty(l, "threeDLayer", {
        get: () => false,
        set: () => {
          throw new Error("no 3D here");
        },
      });
      return l;
    };
    const { A, undo } = loadHost(project, ["layers.jsx"]);
    const items = project.all.length;
    expect(() => A.createLayer({ comp_id: comp.id, type: "solid", name: "S", three_d: true, expect: GUARD })).toThrow(/no 3D here/);
    expect(comp.numLayers).toBe(0);
    expect(project.all.length).toBe(items);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("shortens a video or comp layer to the requested length, never lengthens it", () => {
    const { project, comp } = scene(20);
    const inner = project.addComp("Inner", 320, 180, 10);
    // AE ignores add()'s duration for movies and comps: the layer is as long as its source.
    const orig = comp.layers.add;
    comp.layers.add = (item: any) => {
      const l = orig(item);
      l.outPoint = item.duration;
      return l;
    };
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "precomp", item_id: inner.id, duration: 2, start_time: 1, expect: GUARD });
    const l = comp.layer(1)!;
    expect(l.outPoint - l.inPoint).toBe(2);
    A.createLayer({ comp_id: comp.id, type: "precomp", item_id: inner.id, duration: 15, expect: GUARD });
    const l2 = comp.layer(1)!;
    expect(l2.outPoint - l2.inPoint).toBe(10);
  });
});

describe("lightType in the stack (C53, C54, C91)", () => {
  it("is set on lights only", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "S", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "text", text: "T", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "light", name: "Key", light_type: "spot", expect: GUARD });
    const s = A.layerStack({ comp_id: comp.id });
    const by = (n: string) => s.layers.find((l: { name: string }) => l.name === n);
    expect(by("S")).not.toHaveProperty("lightType");
    expect(by("T")).not.toHaveProperty("lightType");
    expect(by("Key").lightType).toBe("spot");
  });
});

describe("setTrackMatte on camera and light layers (C52)", () => {
  it("refuses them as the layer and as the matte before changing anything", () => {
    const { project, comp } = scene();
    const { A, undo } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "camera", name: "Cam", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "light", name: "Lamp", expect: GUARD });
    const before = undo.begun;
    expect(() => A.setTrackMatte({ comp_id: comp.id, layer: { name: "Cam" }, matte: { name: "Plate" }, type: "alpha", expect: GUARD })).toThrow(/AV layers only/);
    expect(() => A.setTrackMatte({ comp_id: comp.id, layer: { name: "Cam" }, type: "none", expect: GUARD })).toThrow(/AV layers only/);
    expect(() => A.setTrackMatte({ comp_id: comp.id, layer: { name: "Plate" }, matte: { name: "Lamp" }, type: "alpha", expect: GUARD })).toThrow(/can't be a track matte/);
    expect(undo.begun).toBe(before);
    expect(comp.layer("Lamp")!.enabled).toBe(true);
  });
});

describe("layerStack past the 500 cap (C19, C55)", () => {
  function bigComp(n: number) {
    const { project, comp } = scene();
    for (let i = 0; i < n; i++) comp.layers.addNull(1);
    return { project, comp };
  }

  it("lists the layers asked for by id or index beyond the cap", () => {
    const { project, comp } = bigComp(520);
    const bottom = comp.stack[519];
    const second = comp.stack[510];
    const { A } = loadHost(project, ["layers.jsx"]);
    const plain = A.layerStack({ comp_id: comp.id });
    expect(plain.layers.length).toBe(500);
    expect(plain.truncated).toBe(true);
    const s = A.layerStack({ comp_id: comp.id, include_ids: [bottom.id], include_indexes: [511, 3, 9999] });
    expect(s.numLayers).toBe(520);
    expect(s.layers.map((l: { id: number }) => l.id).slice(500)).toEqual([second.id, bottom.id]);
    expect(s.layers[501].index).toBe(520);
  });
});

describe("receipts in a comp past the cap (C19, C55)", () => {
  const big = (n: number, extra: StackLayer[] = []) =>
    stack(
      [...Array.from({ length: 500 }, (_, i) => L(i + 1, 1000 + i, `L${i + 1}`)), ...extra],
      { numLayers: n, truncated: true }
    );

  it("does not call a create at the bottom a failure when the layer is outside the list", () => {
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "solid", placement: { bottom: true }, expect: expectArg });
    expect(createLayerMismatches(args, big(520), big(521), { id: 5000 })).toEqual([]);
  });

  it("checks the new layer when the host included it", () => {
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "solid", placement: { bottom: true }, expect: expectArg });
    const wrong = big(521, [L(520, 5000, "Solid")]);
    expect(createLayerMismatches(args, big(520), wrong, { id: 5000 }).map((m) => m.path)).toEqual(["layer.index"]);
    const right = big(521, [L(521, 5000, "Solid")]);
    expect(createLayerMismatches(args, big(520), right, { id: 5000 })).toEqual([]);
  });

  it("skips a parent or reference that sits past the list", () => {
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "null", parent: { index: 510 }, placement: { above: { index: 510 } }, expect: expectArg });
    const after = big(521, [L(1, 5000, "Ctrl", { kind: "null" })]);
    after.layers[0] = L(1, 5000, "Ctrl", { kind: "null" });
    expect(createLayerMismatches(args, big(520), after, { id: 5000 })).toEqual([]);
  });

  it("skips a precomp layer and a matte layer outside the list", () => {
    const pre = precomposeMismatches(big(520), { ...big(515), with_comp: stack([L(1, 1, "A")]) }, { new_comp_id: 99, layer_indexes: [510, 511, 512, 513, 514, 515], layer_names: ["A"] });
    expect(pre).toEqual([]);
    const args = AeSetTrackMatteSchema.parse({ comp_id: 1, layer: { index: 510 }, type: "alpha", matte: { index: 3 }, expect: expectArg });
    expect(trackMatteMismatches(args, big(520), big(520), { layer: { id: 7777 }, matte: { id: 3 } })).toEqual([]);
  });

  it("asks the host for the written layers by id and index", async () => {
    const afterStack = big(521, [L(521, 5000, "Solid")]);
    const { ctx, calls } = fakeAe({
      layerStack: [big(520), afterStack],
      createLayer: [{ index: 521, id: 5000, name: "Solid", kind: "solid" }],
    });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "solid", placement: { bottom: true }, expect: expectArg });
    const out = await tool("ae_create_layer").handler(args, ctx);
    expect(calls[3].script).toContain('"include_ids":[5000]');
    expect(out.receipt.matches).toBe(true);
    expect(out.layer).toMatchObject({ id: 5000, index: 521 });
  });

  it("asks for the topmost precomposed layer by index and the matte layers by id", async () => {
    const pre = fakeAe({
      layerStack: [big(520), { ...big(515), with_comp: stack([L(1, 1, "A")]) }],
      precomposeLayers: [{ new_comp_id: 99, new_comp_name: "P", layer_indexes: [510, 511], layer_names: ["A"], move_all_attributes: true }],
    });
    await tool("ae_precompose").handler(AePrecomposeSchema.parse({ comp_id: 1, layers: [{ index: 510 }, { index: 511 }], expect: expectArg }), pre.ctx);
    expect(pre.calls[3].script).toContain('"include_indexes":[510]');
    const mat = fakeAe({
      layerStack: [big(520), big(520, [L(510, 7777, "Plate", { trackMatte: { type: "alpha", layer: { index: 511, id: 8888, name: "M" } } })])],
      setTrackMatte: [{ layer: { index: 510, id: 7777, name: "Plate" }, matte: { index: 511, id: 8888, name: "M" }, type: "alpha", api: "setTrackMatte" }],
    });
    await tool("ae_set_track_matte").handler(
      AeSetTrackMatteSchema.parse({ comp_id: 1, layer: { index: 510 }, matte: { index: 511 }, type: "alpha", expect: expectArg }),
      mat.ctx
    );
    expect(mat.calls[1].script).toContain('"include_indexes":[510,511]');
    expect(mat.calls[3].script).toContain("7777");
    expect(mat.calls[3].script).toContain("8888");
  });
});

describe("create layer args per type (C56, C18)", () => {
  const base = { comp_id: 1, expect: expectArg };
  it("rejects arguments that do not belong to the type", () => {
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "solid", light_type: "spot" }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "spot" }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "null", text: "x" }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "null", color: [1, 0, 0] }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "null", item_id: 4 }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "text", text: "x", box_size: [10, 10] }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "adjustment", color: [1, 0, 0], width: 10, height: 10 }).success).toBe(true);
  });

  it("flags a length or start time the layer did not get", () => {
    const before = stack([L(1, 10, "BG")]);
    const after = stack([L(1, 11, "Pre", { kind: "precomp", inPoint: 1, outPoint: 11 }), L(2, 10, "BG")], { frameDuration: 0.04 });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "precomp", item_id: 5, duration: 2, start_time: 2, expect: expectArg });
    expect(createLayerMismatches(args, before, after, { id: 11 }).map((m) => m.path)).toEqual(["layer.inPoint", "layer.duration"]);
    const ok = stack([L(1, 11, "Pre", { kind: "precomp", inPoint: 2, outPoint: 4 }), L(2, 10, "BG")], { frameDuration: 0.04 });
    expect(createLayerMismatches(args, before, ok, { id: 11 })).toEqual([]);
  });

  it("does not check the light type of a non-light layer", () => {
    const before = stack([L(1, 10, "BG")]);
    const after = stack([L(1, 11, "S", { lightType: "undefined" }), L(2, 10, "BG")]);
    const args = { comp_id: 1, type: "solid", light_type: "spot", expect: expectArg } as any;
    expect(createLayerMismatches(args, before, after, { id: 11 })).toEqual([]);
  });
});

describe("removing a track matte when AE keeps the matte type", () => {
  it("clears the type, re-enables the old matte by looking it up again, and the stack reads none", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "text", text: "MATTE", expect: GUARD });
    A.setTrackMatte({ comp_id: comp.id, layer: { name: "Plate" }, matte: { name: "MATTE" }, type: "alpha", expect: GUARD });
    const plate = comp.layer("Plate")!;
    // Seen live in AE 26.2.1 (probe): removeTrackMatte drops the matte layer, the layer still reads the old type (ALPHA 5013) with hasTrackMatte false, and the matte layer stays switched off.
    Object.defineProperty(plate, "hasTrackMatte", { get: () => plate.trackMatteLayer !== null, configurable: true });
    plate.removeTrackMatte = () => {
      plate.trackMatteLayer = null;
    };
    const off = A.setTrackMatte({ comp_id: comp.id, layer: { name: "Plate" }, type: "none", show_matte: true, expect: GUARD });
    expect(off.previous_matte.name).toBe("MATTE");
    expect(plate.trackMatteType).toBe(TrackMatteType.NO_TRACK_MATTE);
    expect(comp.layer("MATTE")!.enabled).toBe(true);
    expect(A.layerStack({ comp_id: comp.id }).layers.find((l: any) => l.name === "Plate").trackMatte).toEqual({ type: "none", layer: null });
  });

  it("reads a layer with a leftover matte type and no matte layer as none", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    const plate = comp.layer("Plate")!;
    plate.trackMatteType = TrackMatteType.ALPHA;
    Object.defineProperty(plate, "hasTrackMatte", { get: () => false, configurable: true });
    expect(A.layerStack({ comp_id: comp.id }).layers[0].trackMatte).toEqual({ type: "none", layer: null });
  });
});
