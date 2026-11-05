import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import {
  AeViewSchema,
  restoreToArgs,
  viewMismatches,
  viewTools,
  type EffectiveView,
  type ViewState,
} from "../src/tools/ext/view.js";
import { FakeComp, FakeFolder, FakeFootage, FakeGroup, FakeLayer, FakeProject, FakeProperty, PropertyType, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = viewTools.find((t) => t.name === "ae_view")!;
const expectArg = { project_path: "<unsaved>" };
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------- fake AE additions (what fake-ae lacks for UI state) ----------

const patched: Array<[object, string]> = [];
function define(proto: object, name: string, desc: PropertyDescriptor) {
  Object.defineProperty(proto, name, { configurable: true, ...desc });
  patched.push([proto, name]);
}
const flag = (proto: object) =>
  define(proto, "selected", {
    get(this: any) {
      return this._sel === true;
    },
    set(this: any, v: boolean) {
      this._sel = v;
    },
  });

function walk(group: FakeGroup, out: Array<FakeProperty | FakeGroup>) {
  for (const p of group.props) {
    out.push(p);
    if (p instanceof FakeGroup) walk(p, out);
  }
}

beforeAll(() => {
  flag(FakeLayer.prototype);
  flag(FakeProperty.prototype);
  flag(FakeGroup.prototype);
  flag(FakeComp.prototype);
  flag(FakeFootage.prototype);
  flag(FakeFolder.prototype);
  define(FakeComp.prototype, "selectedLayers", { get(this: FakeComp) { return this.stack.filter((l: any) => l._sel === true); } });
  define(FakeComp.prototype, "selectedProperties", { get(this: FakeComp) { return this.stack.flatMap((l: any) => l.selectedProperties); } });
  define(FakeLayer.prototype, "selectedProperties", {
    get(this: FakeLayer) {
      const all: Array<FakeProperty | FakeGroup> = [];
      walk(this.group, all);
      return all.filter((p: any) => p._sel === true);
    },
  });
  define(FakeProject.prototype, "selection", { get(this: FakeProject) { return this.all.filter((i: any) => i._sel === true); } });
  define(FakeProperty.prototype, "selectedKeys", { get(this: any) { return Array.from((this._keys ?? new Set<number>()) as Set<number>).sort((a, b) => a - b); } });
  define(FakeProperty.prototype, "setSelectedAtKey", {
    value(this: any, i: number, on: boolean) {
      this.keyTime(i); // throws out of range
      this._keys ??= new Set<number>();
      if (on) this._keys.add(i);
      else this._keys.delete(i);
    },
  });
  // propertyDepth counted from the layer, as in real AE (see w5-core.test.ts)
  const depthOf = (node: any): number => (node.parentProperty ? depthOf(node.parentProperty) + 1 : 0);
  for (const proto of [FakeGroup.prototype, FakeProperty.prototype]) {
    if (!Object.getOwnPropertyDescriptor(proto, "propertyDepth")) define(proto, "propertyDepth", { get(this: any) { return depthOf(this); } });
  }
});
afterAll(() => {
  for (const [proto, name] of patched) delete (proto as any)[name];
});

const ChannelType = {
  CHANNEL_RGB: 1, CHANNEL_RED: 2, CHANNEL_GREEN: 3, CHANNEL_BLUE: 4, CHANNEL_ALPHA: 5, CHANNEL_RGB_STRAIGHT: 6,
  CHANNEL_RED_COLORIZE: 7, CHANNEL_GREEN_COLORIZE: 8, CHANNEL_BLUE_COLORIZE: 9, CHANNEL_ALPHA_BOUNDARY: 10, CHANNEL_ALPHA_OVERLAY: 11,
};
const FastPreviewType = { FP_OFF: 0, FP_ADAPTIVE_RESOLUTION: 1, FP_DRAFT: 2, FP_FAST_DRAFT: 3, FP_WIREFRAME: 4 };
const ViewerType = { VIEWER_COMPOSITION: 100, VIEWER_LAYER: 101, VIEWER_FOOTAGE: 102 };

function makeViewer(type: number, views = 2) {
  const mk = () => ({
    options: { zoom: 1, exposure: 0, channels: ChannelType.CHANNEL_RGB, checkerboards: false, fastPreview: FastPreviewType.FP_OFF, guidesVisibility: true, guidesLocked: false, guidesSnap: true, rulers: false } as Record<string, unknown>,
    activeCalls: 0,
    setActive() { this.activeCalls++; },
  });
  return { type, maximized: false, views: Array.from({ length: views }, mk), activeViewIndex: 0, activeCalls: 0, setActive() { this.activeCalls++; } };
}

function scene(opts: { enums?: boolean; viewer?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4); // 25 fps, 100 frames
  const footage = project.addFootage("clip", 100, 100);
  const a = comp.layers.addSolid([1, 1, 1], "A", 640, 360, 1);
  const b = comp.layers.addSolid([1, 1, 1], "B", 640, 360, 1);
  const c = comp.layers.addSolid([1, 1, 1], "C", 640, 360, 1);
  const pos = a.transform("ADBE Position") as FakeProperty;
  pos.setValueAtTime(0, [0, 0, 0]);
  pos.setValueAtTime(1, [100, 0, 0]);
  pos.setValueAtTime(2, [200, 0, 0]);
  (project as any).activeItem = comp;
  const host = loadHost(project, ["view.jsx"]);
  const G = host.G;
  if (opts.enums !== false) {
    G.ChannelType = ChannelType;
    G.FastPreviewType = FastPreviewType;
    G.ViewerType = ViewerType;
  }
  const viewer = opts.viewer === false ? null : makeViewer(ViewerType.VIEWER_COMPOSITION);
  G.app.activeViewer = viewer;
  // openInViewer makes the item active and the viewer match it
  const opens: string[] = [];
  const openFn = (item: any, type: number, nullFor?: boolean) =>
    function () {
      opens.push(item.name);
      if (nullFor) return null;
      (project as any).activeItem = item.containingComp ?? item;
      G.app.activeViewer = makeViewer(type);
      return G.app.activeViewer;
    };
  (comp as any).openInViewer = openFn(comp, ViewerType.VIEWER_COMPOSITION);
  (comp as any).openInEssentialGraphics = () => opens.push("eg:" + comp.name);
  (footage as any).openInViewer = openFn(footage, ViewerType.VIEWER_FOOTAGE);
  (a as any).openInViewer = openFn(a, ViewerType.VIEWER_LAYER);
  (b as any).openInViewer = openFn(b, ViewerType.VIEWER_LAYER, true);
  return { project, comp, footage, a, b, c, pos, host, A: host.A, G, viewer, opens };
}

const G0 = { expect: expectArg };

// ---------- schema ----------

describe("ae_view schema", () => {
  const ok = (v: unknown) => AeViewSchema.safeParse({ expect: expectArg, ...(v as object) });
  it("needs an action, and takes nothing for a bare call", () => {
    expect(ok({}).success).toBe(false);
    expect(ok({ focus: true }).success).toBe(true);
    expect(ok({ comp_id: 1, time: { frame: 10 } }).success).toBe(true);
  });
  it("time takes exactly one of time or frame, and needs a comp", () => {
    expect(ok({ comp_id: 1, time: { time: 1, frame: 2 } }).success).toBe(false);
    expect(ok({ comp_id: 1, time: {} }).success).toBe(false);
    expect(ok({ time: { time: 1 } }).success).toBe(false);
    expect(ok({ comp_id: 1, time: { frame: -1 } }).success).toBe(false);
  });
  it("open: layer goes with in 'layer', and every open names a comp or item", () => {
    expect(ok({ comp_id: 1, open: { in: "layer" } }).success).toBe(false);
    expect(ok({ comp_id: 1, open: { in: "layer", layer: { index: 1 } } }).success).toBe(true);
    expect(ok({ comp_id: 1, open: { in: "viewer", layer: { index: 1 } } }).success).toBe(false);
    expect(ok({ open: { in: "viewer" } }).success).toBe(false);
    expect(ok({ open: { in: "viewer", item_id: 9 } }).success).toBe(true);
    expect(ok({ open: { in: "essential_graphics" }, comp_id: 3 }).success).toBe(true);
    expect(ok({ open: { in: "nope", item_id: 9 } }).success).toBe(false);
  });
  it("select needs a kind, a comp for layer-ish kinds, and 1-based key indexes", () => {
    expect(ok({ comp_id: 1, select: {} }).success).toBe(false);
    expect(ok({ select: { layers: [{ id: 1 }] } }).success).toBe(false);
    expect(ok({ select: { items: [4] } }).success).toBe(true);
    expect(ok({ comp_id: 1, select: { layers: [] } }).success).toBe(true);
    expect(ok({ comp_id: 1, select: { keys: [{ layer: { id: 1 }, path: ["ADBE Transform Group", "ADBE Position"], indexes: [0] }] } }).success).toBe(false);
    expect(ok({ comp_id: 1, select: { properties: [{ layer: { id: 1 }, path: [] }] } }).success).toBe(false);
    expect(ok({ comp_id: 1, select: { properties: [{ layer: { id: 1 }, path: ["ADBE Effect Parade", 2, "ADBE Blur"] }] } }).success).toBe(true);
  });
  it("viewer_options checks ranges and enums and needs an option", () => {
    expect(ok({ viewer_options: { view_index: 0 } }).success).toBe(false);
    expect(ok({ viewer_options: { zoom: 0.001 } }).success).toBe(false);
    expect(ok({ viewer_options: { zoom: 17 } }).success).toBe(false);
    expect(ok({ viewer_options: { exposure: 41 } }).success).toBe(false);
    expect(ok({ viewer_options: { channels: "luma" } }).success).toBe(false);
    expect(ok({ viewer_options: { channels: "alpha", checkerboards: true, fast_preview: "draft", zoom: 0.5, exposure: -2 } }).success).toBe(true);
  });
  it("restore stands alone", () => {
    expect(ok({ restore: { comp: { id: 1, time: 0 } } }).success).toBe(true);
    expect(ok({ restore: {}, comp_id: 1 }).success).toBe(false);
    expect(ok({ restore: {}, time: { time: 1 } }).success).toBe(false);
    expect(ok({ restore: {}, focus: true }).success).toBe(true);
  });
  it("is a UI write: expect is required and it takes no automatic checkpoint", () => {
    expect(AeViewSchema.safeParse({ focus: true }).success).toBe(false);
    expect(AUTO_CHECKPOINT_TOOLS).not.toContain("ae_view");
    expect(tool.description).toContain("Jay may be editing live");
  });
});

// ---------- pure logic ----------

const baseState = (extra: Partial<ViewState> = {}): ViewState => ({
  active_item: { id: 5, name: "Main", kind: "comp" },
  comp: { id: 5, name: "Main", time: 1.2, frame: 30, frame_rate: 25 },
  selected_layers: [11, 12],
  selected_properties: [
    { layer_id: 11, path: ["ADBE Transform Group", "ADBE Position"], is_group: false, selected_keys: [1, 3] },
    { layer_id: 12, path: ["ADBE Effect Parade"], is_group: true, selected_keys: [] },
  ],
  selected_items: [7],
  viewer: { type: "comp", maximized: false, view_count: 1, active_view_index: 0 },
  view_options: { zoom: 0.5, exposure: 1, channels: "rgb", checkerboards: false, fast_preview: "off", guides_visibility: null, guides_locked: null, guides_snap: null, rulers: true },
  dirty: false,
  missing: [],
  ...extra,
});

describe("restoreToArgs", () => {
  it("turns a state into the operations that put it back", () => {
    const eff = restoreToArgs(baseState());
    expect(eff.comp_id).toBe(5);
    expect(eff.time).toEqual({ time: 1.2 });
    expect(eff.open).toEqual({ in: "viewer", item_id: 5, if_not_active: true });
    expect(eff.select).toMatchObject({
      deselect_others: true,
      layers: [{ id: 11 }, { id: 12 }],
      properties: [
        { layer: { id: 11 }, path: ["ADBE Transform Group", "ADBE Position"] },
        { layer: { id: 12 }, path: ["ADBE Effect Parade"] },
      ],
      keys: [{ layer: { id: 11 }, path: ["ADBE Transform Group", "ADBE Position"], indexes: [1, 3] }],
      items: [7],
    });
    expect(eff.viewer_options).toEqual({ zoom: 0.5, exposure: 1, channels: "rgb", checkerboards: false, fast_preview: "off", rulers: true, view_index: 0 });
  });
  it("keeps the selection when the state was capped, and skips fast_preview outside a comp viewer", () => {
    const eff = restoreToArgs(baseState({ selected_properties_truncated: true, viewer: { type: "layer", active_view_index: 1 } }));
    expect(eff.select?.deselect_others).toBe(false);
    expect(eff.viewer_options).not.toHaveProperty("fast_preview");
    expect(eff.viewer_options?.view_index).toBe(1);
  });
  it("does nothing for an empty state and clears selections for an empty selection", () => {
    expect(restoreToArgs({ active_item: null, comp: null, viewer: null, view_options: null } as unknown as ViewState)).toEqual({});
    const eff = restoreToArgs(baseState({ selected_layers: [], selected_properties: [], selected_items: [] }));
    expect(eff.select).toMatchObject({ layers: [], properties: [], items: [], deselect_others: true });
    expect(eff.select?.keys).toBeUndefined();
  });
});

describe("viewMismatches", () => {
  const eff: EffectiveView = {};
  const after = baseState();
  it("accepts a state that matches what the host said it did", () => {
    expect(
      viewMismatches(eff, after, {
        opened: { in: "viewer", item_id: 5, opened: true },
        time: { applied: 1.2 },
        layers: [12, 11],
        properties: [{ layer_id: 11, path: ["ADBE Transform Group", "ADBE Position"] }],
        keys: [{ layer_id: 11, path: ["ADBE Transform Group", "ADBE Position"], indexes: [3, 1] }],
        items: [7],
        deselect_others: true,
        options_applied: { zoom: 0.5, channels: "rgb", rulers: true },
      })
    ).toEqual([]);
  });
  it("flags each thing that is not as written", () => {
    const m = viewMismatches(eff, after, {
      opened: { in: "viewer", item_id: 99, opened: true },
      time: { applied: 2 },
      layers: [11],
      properties: [{ layer_id: 11, path: ["ADBE Nope"] }],
      keys: [{ layer_id: 11, path: ["ADBE Transform Group", "ADBE Position"], indexes: [1] }],
      items: [8],
      deselect_others: true,
      options_applied: { zoom: 2 },
    });
    expect(m.map((x) => x.path).sort()).toEqual(
      ["active_item.id", "comp.time", "selected_items", "selected_keys", "selected_layers", "selected_properties", "view_options.zoom"].sort()
    );
  });
  it("is lenient when deselect_others is off, when an option was skipped or the read was capped", () => {
    expect(viewMismatches(eff, after, { layers: [11], deselect_others: false, items: [7], options_applied: { zoom: 9 }, skipped: [{ what: "zoom", reason: "x" }] })).toEqual([]);
    expect(viewMismatches(eff, baseState({ selected_layers_truncated: true }), { layers: [1], deselect_others: true })).toEqual([]);
  });
});

// ---------- the tool with a fake bridge ----------

function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-view-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 5, comp_is_valid: true }, durationMs: 1 };
      const next = results[fn]?.shift();
      if (next === undefined) throw new Error(`Unexpected script: ${script}`);
      if (next instanceof Error) throw next;
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

describe("ae_view handler", () => {
  it("guards, reads, writes with no checkpoint, reads back separately, and returns the previous state", async () => {
    const before = baseState({ comp: { id: 5, time: 0 } });
    const after = baseState({ comp: { id: 5, time: 1.2 } });
    const { ctx, calls } = fakeAe({
      viewState: [before, after],
      viewApply: [{ comp_id: 5, time: { requested: 1.2, frame: 30, applied: 1.2, clamped: false }, skipped: [], warnings: [], changed: 1 }],
    });
    const args = AeViewSchema.parse({ comp_id: 5, time: { time: 1.2 }, expect: expectArg });
    const out: any = await tool.handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "viewState", "viewApply", "viewState"]);
    expect(calls[2].script).toContain('"expect"');
    expect(calls[2].script).toContain('"time":{"time":1.2}');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.previous_state.comp.time).toBe(0);
    expect(out.state.comp.time).toBe(1.2);
    expect(out.checkpoint).toBeUndefined();
    expect(out.dirty_before).toBe(false);
  });

  it("puts a wrong read-back into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      viewState: [baseState(), baseState({ comp: { id: 5, time: 0 } })],
      viewApply: [{ comp_id: 5, time: { applied: 2, frame: 50, requested: 2, clamped: false }, changed: 1 }],
    });
    const out: any = await tool.handler(AeViewSchema.parse({ comp_id: 5, time: { time: 2 }, expect: expectArg }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toBe("comp.time");
  });

  it("does not throw when the read-back fails after the write", async () => {
    const { ctx } = fakeAe({
      viewState: [baseState(), new Error("evalScript timed out")],
      viewApply: [{ comp_id: 5, changed: 1 }],
    });
    const out: any = await tool.handler(AeViewSchema.parse({ comp_id: 5, focus: true, expect: expectArg }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches[0].path).toBe("read_back");
  });

  it("a failed read-back still returns previous_state and dirty_before so the agent can restore", async () => {
    const before = baseState({ comp: { id: 5, time: 0 } });
    const { ctx } = fakeAe({ viewState: [before, new Error("evalScript timed out")], viewApply: [{ comp_id: 5, changed: 1 }] });
    const out: any = await tool.handler(AeViewSchema.parse({ comp_id: 5, focus: true, expect: expectArg }), ctx);
    expect(out.previous_state.comp.time).toBe(0);
    expect(out.dirty_before).toBe(false);
  });

  it("restore puts options back on the view they were read from, not the active view", async () => {
    const prev = baseState({ viewer: { type: "comp", active_view_index: 0, options_view_index: 1 } as any });
    const { ctx, calls } = fakeAe({ viewState: [baseState(), prev], viewApply: [{ comp_id: 5, changed: 0, no_op: true }] });
    await tool.handler(AeViewSchema.parse({ restore: prev, expect: expectArg }), ctx);
    expect(calls[2].script).toContain('"view_index":1');
  });

  it("restore sends the previous state's operations and reads its comp", async () => {
    const prev = baseState();
    const { ctx, calls } = fakeAe({ viewState: [baseState(), prev], viewApply: [{ comp_id: 5, changed: 0, no_op: true }] });
    const out: any = await tool.handler(AeViewSchema.parse({ restore: prev, expect: expectArg }), ctx);
    const write = calls[2].script;
    expect(write).toContain('"if_not_active":true');
    expect(write).toContain('"time":{"time":1.2}');
    expect(calls[1].script).toContain('"comp_id":5');
    expect(out.no_op).toBe(true);
  });

  it("refuses when AE reports another project (guard) and touches nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-view-g-"));
    tmpDirs.push(dir);
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "q.json"));
    const seen: string[] = [];
    const host = new PanelHost({
      evalScript: async (script) => {
        seen.push(script.slice("__chromaAe.".length, script.indexOf("(")));
        return { ok: true, result: { ok: false, project_path: "C:/other.aep", comp_id: null, comp_is_valid: true }, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    await expect(tool.handler(AeViewSchema.parse({ focus: true, expect: expectArg }), { bridge: host, queue, quarantine })).rejects.toThrow(/guard/i);
    expect(seen).toEqual(["checkGuard"]);
  });

  it("a restore whose saved comp is gone passes the real guard and leaves the live comps alone", async () => {
    const { A, G, comp, a, b, project, viewer } = scene();
    const other = project.addComp("Other", 640, 360, 4);
    const oa = other.layers.addSolid([1, 1, 1], "OA", 640, 360, 1);
    const third = project.addComp("Third", 640, 360, 4);
    const ta = third.layers.addSolid([1, 1, 1], "TA", 640, 360, 1);
    (third as any).openInViewer = function () {
      (project as any).activeItem = third;
      G.app.activeViewer = makeViewer(ViewerType.VIEWER_COMPOSITION);
      return G.app.activeViewer;
    };
    // the state to restore: Third was the active item, Other the comp the call changed
    (project as any).activeItem = third;
    other.time = 2;
    (oa as any).selected = true;
    const prev = plain(A.viewState({ comp_id: other.id }));
    expect(prev.active_item.id).toBe(third.id);
    expect(prev.comp.id).toBe(other.id);
    // meanwhile: Other is deleted and Main is active, with its own time and selection
    other.remove();
    (project as any).activeItem = comp;
    comp.time = 0;
    third.time = 0;
    (a as any).selected = true;
    (ta as any).selected = true;
    void b;
    void viewer;
    const calls: string[] = [];
    const ctx = liveCtx(G, calls);
    const out: any = await tool.handler(AeViewSchema.parse({ restore: prev, expect: expectArg }), ctx);
    // the guard ran (project only) and the call went through
    expect(calls[0]).toBe("checkGuard");
    expect(calls).toContain("viewApply");
    expect(out.applied).toBe(true);
    // Third was reopened, but the deleted comp's time and selection were not applied to it or to Main
    expect(third.time).toBe(0);
    expect((ta as any).selected).toBe(true);
    expect(comp.time).toBe(0);
    expect((a as any).selected).toBe(true);
    expect(out.skipped.map((x: any) => x.what).join("|")).toMatch(/comp/);
  });

  it("a caller-given expect.comp_id still guards a restore", async () => {
    const { A, G, project } = scene();
    const other = project.addComp("Other", 640, 360, 4);
    const prev = plain(A.viewState({ comp_id: other.id }));
    other.remove();
    const calls: string[] = [];
    await expect(
      tool.handler(AeViewSchema.parse({ restore: prev, expect: { ...expectArg, comp_id: other.id } }), liveCtx(G, calls))
    ).rejects.toThrow(/guard/i);
    expect(calls).toEqual(["checkGuard"]);
  });
});

/** A bridge that runs each script in the vm host. */
function liveCtx(G: Record<string, any>, calls: string[]): ToolContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-view-l-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      calls.push(script.slice("__chromaAe.".length, script.indexOf("(")));
      try {
        const result = vm.runInContext(script, G);
        return { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)), durationMs: 1 };
      } catch (e) {
        const err = e as Error & { __kind?: string };
        return { ok: false, error: { message: err.message, kind: err.__kind ?? "runtime" }, durationMs: 1 };
      }
    },
    queue,
    quarantine,
  });
  return { bridge: host, queue, quarantine };
}

// ---------- the host under node:vm ----------

describe("viewState", () => {
  it("reads the active item, comp time, selections and view options without changing anything", () => {
    const { A, comp, a, b, pos, host, project, viewer } = scene();
    comp.time = 1.5;
    (a as any).selected = true;
    (b as any).selected = true;
    pos.selected = true as never;
    (pos as any).setSelectedAtKey(2, true);
    (project.item(2) as any).selected = true;
    const s = plain(A.viewState({}));
    expect(s.active_item).toMatchObject({ id: comp.id, kind: "comp" });
    expect(s.comp).toMatchObject({ id: comp.id, time: 1.5, frame: 38, frame_rate: 25 });
    expect(s.selected_layers.sort()).toEqual([a.id, b.id].sort());
    expect(s.selected_properties).toEqual([
      { layer_id: a.id, layer_index: a.index, path: ["ADBE Transform Group", "ADBE Position"], name: "Position", is_group: false, selected_keys: [2] },
    ]);
    expect(s.selected_items).toEqual([project.item(2)!.id]);
    expect(s.viewer).toMatchObject({ type: "comp", view_count: 2, active_view_index: 0 });
    expect(s.view_options).toMatchObject({ zoom: 1, exposure: 0, channels: "rgb", fast_preview: "off", rulers: false, guides_snap: true });
    expect(s.dirty).toBe(false);
    expect(host.undo).toEqual({ begun: 0, ended: 0 });
    expect(viewer!.activeCalls).toBe(0);
    expect(comp.time).toBe(1.5);
  });

  it("says what is missing: no viewer, and options this AE lacks", () => {
    const none = scene({ viewer: false });
    expect(plain(none.A.viewState({})).missing.join(" ")).toContain("app.activeViewer");
    expect(plain(none.A.viewState({})).viewer).toBeNull();
    const old = scene();
    delete (old.viewer!.views[0].options as any).guidesLocked;
    delete (old.viewer!.views[0].options as any).rulers;
    const s = plain(old.A.viewState({}));
    expect(s.view_options.guides_locked).toBeNull();
    expect(s.missing).toEqual(expect.arrayContaining(["ViewOptions.guidesLocked (AE 16.1)", "ViewOptions.rulers (AE 16.1)"]));
  });

  it("reports an id that is not a comp instead of throwing", () => {
    const { A, footage } = scene();
    const s = plain(A.viewState({ comp_id: footage.id }));
    expect(s.comp).toBeNull();
    expect(s.missing[0]).toContain("not a CompItem");
  });
});

describe("viewApply", () => {
  it("opens an item only when asked, and never touches focus otherwise", () => {
    const { A, comp, a, viewer, opens, footage } = scene();
    A.viewApply({ ...G0, comp_id: comp.id, time: { frame: 10 }, select: { layers: [{ id: a.id }] }, viewer_options: { zoom: 2 } });
    expect(opens).toEqual([]);
    expect(viewer!.activeCalls).toBe(0);
    expect(viewer!.views[0].activeCalls).toBe(0);
    const r = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: footage.id } }));
    expect(opens).toEqual(["clip"]);
    expect(r.opened).toMatchObject({ in: "viewer", item_id: footage.id, opened: true });
  });

  it("opens a comp in the viewer, a layer in the Layer panel, and a comp in Essential Graphics", () => {
    const { A, comp, a, opens } = scene();
    expect(plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: comp.id } })).opened.opened).toBe(true);
    const lr = plain(A.viewApply({ ...G0, comp_id: comp.id, open: { in: "layer", layer: { id: a.id } } }));
    expect(lr.opened).toMatchObject({ in: "layer", layer_id: a.id, item_id: comp.id, opened: true });
    expect(plain(A.viewApply({ ...G0, comp_id: comp.id, open: { in: "essential_graphics" } })).opened.opened).toBe(true);
    expect(opens).toEqual(["Main", "A", "eg:Main"]);
  });

  it("reports a null openInViewer (text and shape layers) instead of failing", () => {
    const { A, comp, b } = scene();
    const r = plain(A.viewApply({ ...G0, comp_id: comp.id, open: { in: "layer", layer: { id: b.id } } }));
    expect(r.opened.opened).toBe(false);
    expect(r.opened.reason).toContain("returned null");
    expect(r.warnings.length).toBe(1);
    expect(r.no_op).toBe(true);
  });

  it("skips opening an item that is already active with if_not_active", () => {
    const { A, comp, opens } = scene();
    const r = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: comp.id, if_not_active: true } }));
    expect(opens).toEqual([]);
    expect(r.opened.skipped).toBe("already the active item");
    expect(r.no_op).toBe(true);
  });

  it("refuses what cannot open before changing anything", () => {
    const { A, comp, project, G } = scene();
    const folder = project.addFolder("F");
    expect(() => A.viewApply({ ...G0, open: { in: "viewer", item_id: folder.id } })).toThrow(/Only comps and footage/);
    expect(() => A.viewApply({ ...G0, open: { in: "essential_graphics", item_id: project.item(2)!.id } })).toThrow(/Essential Graphics opens a comp/);
    delete (comp as any).openInEssentialGraphics;
    expect(() => A.viewApply({ ...G0, open: { in: "essential_graphics", item_id: comp.id } })).toThrow(/AE 15.0/);
    expect(() => A.viewApply({ ...G0, open: { in: "viewer" } })).toThrow(/item_id/);
    expect(() => A.viewApply({ ...G0, open: { in: "layer", layer: { id: 1 } } })).toThrow(/needs its comp/);
    expect(G.app.activeViewer.activeCalls).toBe(0);
  });

  it("parks the time on a frame, clamped to the comp", () => {
    const { A, comp } = scene();
    let r = plain(A.viewApply({ ...G0, comp_id: comp.id, time: { time: 1.013 } }));
    expect(r.time).toMatchObject({ frame: 25, applied: 1, clamped: false });
    expect(comp.time).toBeCloseTo(1, 6);
    r = plain(A.viewApply({ ...G0, comp_id: comp.id, time: { frame: 9999 } }));
    expect(r.time).toMatchObject({ frame: 99, clamped: true });
    expect(comp.time).toBeCloseTo(3.96, 6);
    r = plain(A.viewApply({ ...G0, comp_id: comp.id, time: { time: -5 } }));
    expect(r.time).toMatchObject({ frame: 0, applied: 0, clamped: true });
    expect(comp.time).toBe(0);
    r = plain(A.viewApply({ ...G0, comp_id: comp.id, time: { time: 0 } }));
    expect(r.no_op).toBe(true);
    expect(() => A.viewApply({ ...G0, comp_id: comp.id, time: { time: "x" } })).toThrow(/finite/);
    expect(() => A.viewApply({ ...G0, time: { time: 1 } })).toThrow(/needs a comp/);
  });

  it("selects layers, deselecting the others by default, or keeping them", () => {
    const { A, comp, a, b, c } = scene();
    (c as any).selected = true;
    let r = plain(A.viewApply({ ...G0, comp_id: comp.id, select: { layers: [{ id: a.id }, { name: "B" }] } }));
    expect(r.layers.sort()).toEqual([a.id, b.id].sort());
    expect((comp as any).selectedLayers.map((l: FakeLayer) => l.name).sort()).toEqual(["A", "B"]);
    expect(r.deselect_others).toBe(true);
    r = plain(A.viewApply({ ...G0, comp_id: comp.id, select: { layers: [{ name: "C" }], deselect_others: false } }));
    expect((comp as any).selectedLayers).toHaveLength(3);
    r = plain(A.viewApply({ ...G0, comp_id: comp.id, select: { layers: [] } }));
    expect((comp as any).selectedLayers).toHaveLength(0);
    expect(r.changed).toBe(3);
    r = plain(A.viewApply({ ...G0, comp_id: comp.id, select: { layers: [] } }));
    expect(r.no_op).toBe(true);
  });

  it("refuses an unknown or ambiguous layer before selecting anything", () => {
    const { A, comp, a } = scene();
    expect(() => A.viewApply({ ...G0, comp_id: comp.id, select: { layers: [{ id: a.id }, { id: 424242 }] } })).toThrow(/No layer with id/);
    expect((comp as any).selectedLayers).toHaveLength(0);
    expect(() => A.viewApply({ ...G0, select: { layers: [{ id: a.id }] } })).toThrow(/needs a comp/);
  });

  it("selects properties and keyframes with the paths ae_status reports, and returns canonical paths", () => {
    const { A, comp, a, pos } = scene();
    const r = plain(
      A.viewApply({
        ...G0,
        comp_id: comp.id,
        select: {
          properties: [{ layer: { id: a.id }, path: ["ADBE Transform Group", "Opacity"] }],
          keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group", "ADBE Position"], indexes: [1, 3, 3] }],
        },
      })
    );
    expect(r.properties).toEqual([
      { layer_id: a.id, path: ["ADBE Transform Group", "ADBE Opacity"] },
      { layer_id: a.id, path: ["ADBE Transform Group", "ADBE Position"] },
    ]);
    expect(r.keys).toEqual([{ layer_id: a.id, path: ["ADBE Transform Group", "ADBE Position"], indexes: [1, 3] }]);
    expect((pos as any).selectedKeys).toEqual([1, 3]);
    const s = plain(A.viewState({ comp_id: comp.id }));
    expect(s.selected_properties.map((e: any) => e.path.join("/")).sort()).toEqual(["ADBE Transform Group/ADBE Opacity", "ADBE Transform Group/ADBE Position"]);
    // a second call with other keys deselects the old ones on that property
    A.viewApply({ ...G0, comp_id: comp.id, select: { keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group", "ADBE Position"], indexes: [2] }] } });
    expect((pos as any).selectedKeys).toEqual([2]);
    // and the old property selection went with deselect_others
    expect(plain(A.viewState({ comp_id: comp.id })).selected_properties).toHaveLength(1);
  });

  it("refuses bad property and key requests before selecting anything", () => {
    const { A, comp, a } = scene();
    const bad = (select: unknown) => () => A.viewApply({ ...G0, comp_id: comp.id, select });
    expect(bad({ properties: [{ layer: { id: a.id }, path: ["ADBE Transform Group", "ADBE Nope"] }] })).toThrow(/not found/);
    expect(bad({ keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group"], indexes: [1] }] })).toThrow(/group/);
    expect(bad({ keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group", "ADBE Opacity"], indexes: [1] }] })).toThrow(/no keyframes/);
    expect(bad({ keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group", "ADBE Position"], indexes: [4] }] })).toThrow(/outside 1\.\.3/);
    expect(bad({ properties: [{ layer: { id: a.id }, path: "x" }] })).toThrow(/non-empty array/);
    expect((comp as any).selectedProperties).toHaveLength(0);
  });

  it("selects project items and deselects the others", () => {
    const { A, project, footage, comp } = scene();
    (comp as any).selected = true;
    const r = plain(A.viewApply({ ...G0, select: { items: [footage.id] } }));
    expect(r.items).toEqual([footage.id]);
    expect(project.selection.map((i: any) => i.name)).toEqual(["clip"]);
    expect(() => A.viewApply({ ...G0, select: { items: [987654] } })).toThrow(/No project item/);
  });

  it("sets viewer options on the active view and reports the rest", () => {
    const { A, viewer } = scene();
    const r = plain(
      A.viewApply({ ...G0, viewer_options: { zoom: 0.5, exposure: -1.5, channels: "alpha", checkerboards: true, fast_preview: "wireframe", guides_snap: false, rulers: true } })
    );
    const o = viewer!.views[0].options;
    expect(o).toMatchObject({ zoom: 0.5, exposure: -1.5, channels: ChannelType.CHANNEL_ALPHA, checkerboards: true, fastPreview: FastPreviewType.FP_WIREFRAME, guidesSnap: false, rulers: true });
    expect(r.options_applied).toMatchObject({ zoom: 0.5, channels: "alpha", fast_preview: "wireframe" });
    expect(r.skipped).toEqual([]);
    // the second view is untouched unless asked for
    expect(viewer!.views[1].options.zoom).toBe(1);
    A.viewApply({ ...G0, viewer_options: { view_index: 1, zoom: 4 } });
    expect(viewer!.views[1].options.zoom).toBe(4);
    expect(viewer!.views[0].activeCalls + viewer!.views[1].activeCalls + viewer!.activeCalls).toBe(0);
    expect(plain(A.viewApply({ ...G0, viewer_options: { zoom: 0.5, channels: "alpha" } })).no_op).toBe(true);
  });

  it("version-guards options this AE lacks and options AE rejects", () => {
    const { A, viewer } = scene();
    delete viewer!.views[0].options.guidesLocked;
    Object.defineProperty(viewer!.views[0].options, "exposure", { get: () => 0, set: () => { throw new Error("nope"); }, configurable: true });
    const r = plain(A.viewApply({ ...G0, viewer_options: { guides_locked: true, exposure: 3, zoom: 2 } }));
    expect(r.skipped).toEqual([
      { what: "exposure", reason: "nope" },
      { what: "guides_locked", reason: "ViewOptions.guidesLocked is not available in this AE version (AE 16.1)" },
    ]);
    expect(r.options_applied).toEqual({ zoom: 2 });
    expect(viewer!.views[0].options.zoom).toBe(2);
  });

  it("validates option values and states before applying anything", () => {
    const { A, comp, viewer, G } = scene();
    const bad = (vo: unknown, re: RegExp) => expect(() => A.viewApply({ ...G0, comp_id: comp.id, time: { frame: 5 }, viewer_options: vo })).toThrow(re);
    bad({ zoom: 99 }, /between 0.01 and 16/);
    bad({ exposure: -99 }, /between -40 and 40/);
    bad({ channels: "luma" }, /Unknown or unsupported channels/);
    bad({ fast_preview: "turbo" }, /Unknown or unsupported fast_preview/);
    bad({ rulers: "yes" }, /true or false/);
    bad({ view_index: 7, zoom: 1 }, /outside 0\.\.1/);
    (comp as any).renderer = "ADBE Advanced 3d";
    bad({ fast_preview: "draft" }, /Classic 3D/);
    expect(comp.time).toBe(0); // nothing was applied
    expect(() => A.viewApply({ ...G0, viewer_options: { fast_preview: "off" } })).not.toThrow();
    G.app.activeViewer = makeViewer(ViewerType.VIEWER_LAYER);
    expect(() => A.viewApply({ ...G0, viewer_options: { fast_preview: "off" } })).toThrow(/Composition viewer/);
    expect(() => A.viewApply({ ...G0, viewer_options: { zoom: 2 } })).not.toThrow();
    expect(viewer!.views[0].options.zoom).toBe(1);
  });

  it("refuses options without a viewer unless it opens one, and says so when the open gave none", () => {
    const { A, comp, G, footage } = scene({ viewer: false });
    expect(() => A.viewApply({ ...G0, viewer_options: { zoom: 2 } })).toThrow(/no active viewer/i);
    (G.app as any).activeViewer = null;
    (comp as any).openInViewer = () => null;
    const r = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: comp.id }, viewer_options: { zoom: 2 } }));
    expect(r.opened.opened).toBe(false);
    expect(r.skipped).toEqual([{ what: "zoom", reason: "no active viewer after the open" }]);
    // after a real open the options land on the new viewer
    const r2 = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: footage.id }, viewer_options: { zoom: 2, checkerboards: true } }));
    expect(r2.opened.opened).toBe(true);
    expect(G.app.activeViewer.views[0].options).toMatchObject({ zoom: 2, checkerboards: true });
  });

  it("fast_preview is refused for the footage viewer it is about to open", () => {
    const { A, footage } = scene();
    expect(() => A.viewApply({ ...G0, open: { in: "viewer", item_id: footage.id }, viewer_options: { fast_preview: "off" } })).toThrow(/Composition viewer/);
  });

  it("activates the viewer only with focus: true", () => {
    const { A, viewer } = scene();
    A.viewApply({ ...G0, viewer_options: { zoom: 3 } });
    expect(viewer!.activeCalls).toBe(0);
    const r = plain(A.viewApply({ ...G0, focus: true }));
    expect(viewer!.activeCalls).toBe(1);
    expect(r.focused).toBe(true);
    const none = scene({ viewer: false });
    const r2 = plain(none.A.viewApply({ ...G0, focus: true }));
    expect(r2.warnings[0]).toContain("no active viewer");
    expect(r2.no_op).toBe(true);
  });

  it("opens no undo group", () => {
    const { A, comp, a, host } = scene();
    A.viewApply({ ...G0, comp_id: comp.id, time: { frame: 3 }, select: { layers: [{ id: a.id }] }, viewer_options: { zoom: 2 } });
    expect(host.undo).toEqual({ begun: 0, ended: 0 });
  });

  it("applies the guard first", () => {
    const { A, comp } = scene();
    try {
      A.viewApply({ expect: { project_path: "C:/other.aep" }, comp_id: comp.id, time: { frame: 3 } });
      throw new Error("expected a guard error");
    } catch (e) {
      expect((e as any).__kind).toBe("guard");
    }
    expect(comp.time).toBe(0);
    expect(() => A.viewApply({ comp_id: comp.id, time: { frame: 3 } })).toThrow(/no expect/);
  });

  it("round trip: apply, then restore the previous state", () => {
    const { A, comp, a, b, pos, footage, project, G } = scene();
    // the user's state
    comp.time = 2;
    (b as any).selected = true;
    pos.selected = true as never;
    (pos as any).setSelectedAtKey(1, true);
    const prev = plain(A.viewState({ comp_id: comp.id }));
    // the agent hands something over
    A.viewApply({
      ...G0,
      open: { in: "viewer", item_id: footage.id },
      comp_id: comp.id,
      time: { frame: 5 },
      select: { layers: [{ id: a.id }], properties: [], items: [footage.id] },
      viewer_options: { zoom: 4 },
    });
    expect((project as any).activeItem).toBe(footage);
    // put it back
    const eff = restoreToArgs(prev);
    const r = plain(A.viewApply({ ...G0, ...eff }));
    expect(r.warnings).toEqual([]);
    expect((project as any).activeItem).toBe(comp);
    const now = plain(A.viewState({ comp_id: comp.id }));
    expect(now.comp.time).toBe(prev.comp.time);
    expect(now.selected_layers).toEqual(prev.selected_layers);
    expect(now.selected_properties).toEqual(prev.selected_properties);
    expect(now.selected_items).toEqual(prev.selected_items);
    expect(G.app.activeViewer.views[0].options.zoom).toBe(1);
  });
});

describe("view review fixes 2", () => {
  const emptyAfter = { selected_layers: [], selected_properties: [], selected_items: [], missing: [] } as any;

  it("viewState records which view the options came from", () => {
    const { A } = scene();
    expect(plain(A.viewState({})).viewer.options_view_index).toBe(0);
    const s = plain(A.viewState({ view_index: 1 }));
    expect(s.viewer).toMatchObject({ active_view_index: 0, options_view_index: 1 });
    const eff: any = restoreToArgs(s);
    expect(eff.viewer_options.view_index).toBe(1);
    expect(restoreToArgs({ ...s, viewer: { type: "comp", active_view_index: 0 } } as any).viewer_options?.view_index).toBe(0);
  });

  it("round trip of options on a named view restores that view", () => {
    const { A, G, comp } = scene();
    const views = G.app.activeViewer.views;
    views[1].options.zoom = 2;
    const prev = plain(A.viewState({ comp_id: comp.id, view_index: 1 }));
    A.viewApply({ ...G0, comp_id: comp.id, viewer_options: { view_index: 1, channels: "alpha", zoom: 4 } });
    A.viewApply({ ...G0, ...restoreToArgs(prev), restore: true });
    expect(views[1].options.zoom).toBe(2);
    expect(views[0].options.zoom).toBe(1);
    expect(views[1].options.channels).toBe(ChannelType.CHANNEL_RGB);
  });

  it("options_verifiable does not depend on wrapper identity", () => {
    const { A, G, footage, project } = scene();
    const real = makeViewer(ViewerType.VIEWER_FOOTAGE);
    let live: any = null;
    (footage as any).openInViewer = () => {
      (project as any).activeItem = footage;
      live = real;
      return Object.create(real);
    };
    // every lookup of app.activeViewer hands back a new wrapper
    Object.defineProperty(G.app, "activeViewer", { get: () => (live ? Object.create(live) : null), configurable: true });
    const r = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: footage.id }, viewer_options: { zoom: 3 } }));
    expect(r.options_verifiable).toBe(true);
  });

  it("a restore skips what no longer exists and restores the rest", () => {
    const { A, comp, b, pos, footage } = scene();
    comp.time = 2;
    (b as any).selected = true;
    pos.selected = true as never;
    (pos as any).setSelectedAtKey(3, true);
    (footage as any).selected = true;
    const prev = plain(A.viewState({ comp_id: comp.id }));
    expect(prev.selected_items).toEqual([footage.id]);
    // the user edits meanwhile: layer b gone, key 3 gone, footage gone
    comp.time = 0;
    (b as any).selected = false;
    (pos as any).setSelectedAtKey(3, false);
    b.remove();
    (pos as any).removeKey(3);
    footage.remove();
    const eff: any = restoreToArgs(prev);
    let r: any;
    expect(() => {
      r = plain(A.viewApply({ ...G0, ...eff, restore: true, viewer_type: "comp" }));
    }).not.toThrow();
    expect(comp.time).toBe(2);
    const what = r.skipped.map((x: any) => x.what).join("|");
    expect(what).toMatch(/layer/);
    expect(what).toMatch(/item/);
    expect(what).toMatch(/key 3/);
    // a non-restore call with the same bad targets still refuses
    expect(() => A.viewApply({ ...G0, comp_id: comp.id, select: { layers: [{ id: 424242 }] } })).toThrow(/No layer/);
  });

  it("a restore whose comp was deleted skips time and selection and still sets the options", () => {
    const { A, comp, project, viewer } = scene();
    const other = project.addComp("Other", 640, 360, 4);
    other.layers.addSolid([1, 1, 1], "X", 640, 360, 1);
    const eff: any = {
      comp_id: other.id,
      time: { time: 1 },
      select: { layers: [{ id: 1 }], deselect_others: true },
      viewer_options: { zoom: 2, view_index: 0 },
    };
    other.remove();
    expect(() => A.viewApply({ ...G0, ...eff })).toThrow();
    const r = plain(A.viewApply({ ...G0, ...eff, restore: true, viewer_type: "comp" }));
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(viewer!.views[0].options.zoom).toBe(2);
    expect(comp.time).toBe(0);
  });

  it("a restore with a deleted comp_id does not apply its time and selection to the comp open reopens", () => {
    const { A, comp, a, project } = scene();
    const other = project.addComp("Other", 640, 360, 4);
    const eff: any = {
      comp_id: other.id,
      open: { in: "viewer", item_id: comp.id },
      time: { time: 1 },
      select: { layers: [{ id: 1 }], deselect_others: true },
    };
    other.remove();
    comp.time = 0.4;
    (a as any).selected = true;
    const r = plain(A.viewApply({ ...G0, ...eff, restore: true, viewer_type: "comp" }));
    expect(comp.time).toBeCloseTo(0.4, 6);
    expect((a as any).selected).toBe(true);
    expect(r.skipped.map((x: any) => x.what).join("|")).toMatch(/comp|time|selection/);
  });

  it("a restore never fails as a whole on a Classic 3D draft preview or a key path that became a group", () => {
    const { A, comp, a, project } = scene();
    const classic = project.addComp("Classic", 640, 360, 4);
    (classic as any).renderer = "ADBE Advanced 3d";
    (project as any).activeItem = classic;
    comp.time = 0;
    let r: any;
    expect(() => {
      r = plain(A.viewApply({ ...G0, restore: true, viewer_type: "comp", comp_id: comp.id, time: { time: 1 }, viewer_options: { fast_preview: "draft" } }));
    }).not.toThrow();
    expect(comp.time).toBeCloseTo(1, 6);
    expect(r.skipped.some((x: any) => x.what === "fast_preview")).toBe(true);
    // the same draft request outside a restore is still refused
    expect(() => A.viewApply({ ...G0, comp_id: comp.id, viewer_options: { fast_preview: "draft" } })).toThrow(/Classic 3D/);
    // a saved key path that now names a group
    let r2: any;
    expect(() => {
      r2 = plain(A.viewApply({ ...G0, restore: true, comp_id: comp.id, select: { keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group"], indexes: [1] }] } }));
    }).not.toThrow();
    expect(r2.skipped.some((x: any) => /keys on layer/.test(x.what))).toBe(true);
    expect(() => A.viewApply({ ...G0, comp_id: comp.id, select: { keys: [{ layer: { id: a.id }, path: ["ADBE Transform Group"], indexes: [1] }] } })).toThrow(/group/);
  });

  it("fast_preview draft falls back to comp_id when neither the open item nor the active comp is known", () => {
    const { A, project } = scene();
    const classic = project.addComp("Classic", 640, 360, 4);
    (classic as any).renderer = "ADBE Advanced 3d";
    (project as any).activeItem = null;
    expect(() => A.viewApply({ ...G0, comp_id: classic.id, viewer_options: { fast_preview: "draft" } })).toThrow(/Classic 3D/);
  });

  it("fast_preview draft falls back to comp_id when the active item is footage, not a comp", () => {
    const { A, project, footage } = scene();
    const classic = project.addComp("Classic", 640, 360, 4);
    (classic as any).renderer = "ADBE Advanced 3d";
    (project as any).activeItem = footage;
    expect(() => A.viewApply({ ...G0, comp_id: classic.id, viewer_options: { fast_preview: "draft" } })).toThrow(/Classic 3D/);
  });

  it("a restore whose previous item is gone does not fail", () => {
    const { A, footage } = scene();
    const id = footage.id;
    footage.remove();
    const r = plain(A.viewApply({ ...G0, restore: true, open: { in: "viewer", item_id: id, if_not_active: true }, viewer_options: { zoom: 2 } }));
    expect(r.skipped.some((x: any) => /open item/.test(x.what))).toBe(true);
  });

  it("fast_preview draft checks the comp the viewer shows, not comp_id", () => {
    const { A, comp, project, viewer } = scene();
    const classic = project.addComp("Classic", 640, 360, 4);
    (classic as any).renderer = "ADBE Advanced 3d";
    // the viewer shows Main (not Classic 3D): comp_id naming the Classic comp does not block it
    expect(() => A.viewApply({ ...G0, comp_id: classic.id, time: { frame: 3 }, viewer_options: { fast_preview: "draft" } })).not.toThrow();
    expect(classic.time).toBeCloseTo(0.12, 6);
    expect(viewer!.views[0].options.fastPreview).toBe(FastPreviewType.FP_DRAFT);
    // the viewer shows a Classic 3D comp: refused even though comp_id names another comp
    (project as any).activeItem = classic;
    expect(() => A.viewApply({ ...G0, comp_id: comp.id, viewer_options: { fast_preview: "draft" } })).toThrow(/Classic 3D/);
  });

  it("viewMismatches flags options it could not read back when there is no active viewer", () => {
    const mm = viewMismatches({}, { ...emptyAfter, view_options: null } as any, { options_applied: { zoom: 2 }, options_target: "active_viewer" } as any);
    expect(mm.length).toBe(1);
    expect(mm[0].path).toBe("view_options");
    expect(viewMismatches({}, { ...emptyAfter, view_options: null } as any, { options_applied: {} } as any)).toEqual([]);
    expect(viewMismatches({}, { ...emptyAfter, view_options: null } as any, { options_applied: { zoom: 2 }, skipped: [{ what: "zoom", reason: "x" }] } as any)).toEqual([]);
  });
});

describe("view review fixes", () => {
  it("fast_preview uses the FP_ prefixed enum names and fails with the unprefixed ones", () => {
    const { A, viewer, G } = scene();
    A.viewApply({ ...G0, viewer_options: { fast_preview: "draft" } });
    expect(viewer!.views[0].options.fastPreview).toBe(2);
    expect(plain(A.viewState({})).view_options.fast_preview).toBe("draft");
    G.FastPreviewType = { OFF: 0, ADAPTIVE_RESOLUTION: 1, DRAFT: 2, FAST_DRAFT: 3, WIREFRAME: 4 };
    expect(() => A.viewApply({ ...G0, viewer_options: { fast_preview: "off" } })).toThrow(/Unknown or unsupported fast_preview/);
  });

  it("options go to the viewer open returned, flagged unverifiable when it is not the active one", () => {
    const { A, footage, G, viewer, project } = scene();
    const fresh = makeViewer(ViewerType.VIEWER_FOOTAGE);
    (footage as any).openInViewer = () => fresh;
    const r = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: footage.id }, viewer_options: { zoom: 3 } }));
    expect(fresh.views[0].options.zoom).toBe(3);
    expect(viewer!.views[0].options.zoom).toBe(1);
    expect(r.options_target).toBe("opened_viewer");
    expect(r.options_verifiable).toBe(false);
    const w = { options_applied: r.options_applied, options_target: "opened_viewer", options_verifiable: false };
    const mm = viewMismatches({}, { view_options: { zoom: 1 }, selected_layers: [], selected_properties: [], selected_items: [], missing: [] } as any, w as any);
    expect(mm.length).toBe(1);
    G.app.activeViewer = fresh;
    // the opened footage is the active item once open has run
    (footage as any).openInViewer = () => {
      (project as any).activeItem = footage;
      return fresh;
    };
    const r2 = plain(A.viewApply({ ...G0, open: { in: "viewer", item_id: footage.id }, viewer_options: { zoom: 5 } }));
    expect(r2.options_verifiable).toBe(true);
  });

  it("a restore with no active item and no viewer still restores time and selection", () => {
    const { A, comp, a, G } = scene({ viewer: false });
    (G.app as any).activeViewer = null;
    comp.time = 1;
    (a as any).selected = true;
    const prev = plain(A.viewState({ comp_id: comp.id }));
    comp.time = 2;
    (a as any).selected = false;
    const eff: any = restoreToArgs({ ...prev, active_item: null, view_options: { zoom: 2 }, viewer: { type: "comp", active_view_index: 5 } } as any);
    expect(eff.viewer_options).toBeDefined();
    const r = plain(A.viewApply({ ...G0, ...eff, restore: true, viewer_type: "comp" }));
    expect(comp.time).toBe(1);
    expect((a as any).selected).toBe(true);
    expect(r.skipped.length).toBe(1);
    // a viewer with fewer views than the saved index, and one of another type
    G.app.activeViewer = makeViewer(ViewerType.VIEWER_COMPOSITION);
    const r2 = plain(A.viewApply({ ...G0, ...eff, restore: true, viewer_type: "comp" }));
    expect(r2.skipped[0].reason).toMatch(/view_index/);
    G.app.activeViewer = makeViewer(ViewerType.VIEWER_LAYER);
    const r3 = plain(A.viewApply({ ...G0, comp_id: comp.id, viewer_options: { zoom: 2 }, restore: true, viewer_type: "comp" }));
    expect(r3.skipped[0].reason).toMatch(/layer viewer/);
    expect(G.app.activeViewer.views[0].options.zoom).toBe(1);
  });

  it("restoring a state that is already in place is a no-op, and wantProps are deduplicated", () => {
    const { A, comp, pos } = scene();
    pos.selected = true as never;
    (pos as any).setSelectedAtKey(1, true);
    const prev = plain(A.viewState({ comp_id: comp.id }));
    const eff: any = restoreToArgs(prev);
    const r = plain(A.viewApply({ ...G0, ...eff, restore: true }));
    expect(r.no_op).toBe(true);
    expect(r.properties.length).toBe(1);
  });

  it("marks the property read as truncated when the layer scan cannot find them all", () => {
    const { A, comp, pos } = scene();
    pos.selected = true as never;
    Object.defineProperty(comp, "selectedProperties", { get: () => [pos, pos, pos], configurable: true });
    expect(plain(A.viewState({ comp_id: comp.id })).selected_properties_truncated).toBe(true);
  });

  it("does not read fastPreview in a Layer viewer and says why", () => {
    const { A, G } = scene();
    G.app.activeViewer = makeViewer(ViewerType.VIEWER_LAYER);
    const s = plain(A.viewState({}));
    expect(s.view_options.fast_preview).toBeNull();
    expect(s.missing.join(" ")).toMatch(/not available in a Layer\/Footage viewer/);
  });
});
