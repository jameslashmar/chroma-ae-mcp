/**
 * Wave 5 core: ae_save save_as / increment, ae_status detail, property metadata,
 * Shape and Marker values, expression_error, and the shared host kits other
 * groups build on (property paths, fonts, glyph check, TextDocument, shapes).
 * The host code runs for real under node:vm against support/fake-ae.ts; AE
 * members that fake does not have are added here, on the instances.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { CORE_HOST_FUNCTIONS_WAVE5 } from "../src/jsx.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeSaveSchema,
  AeSetPropertySchema,
  checkSaveAsTarget,
  mutateTools,
  nextIncrementPath,
  normaliseExpectedValue,
  saveAsPathProblem,
} from "../src/tools/mutate.js";
import { AeGetLayerPropsSchema, AeStatusSchema, readTools } from "../src/tools/read.js";
import { getSessionTracker, installSessionTracking, resetSessionTracking, type SessionSnapshot } from "../src/tools/ext/session.js";
import { resetResourceCache, resourceDeps } from "../src/system-resources.js";
import { pickEnvironment } from "../src/tools/ext/diagnostics.js";
import { disablePolicyForSwitch, setAutosavePolicy, stopAutosavePolicy } from "../src/tools/ext/projectsession.js";
import {
  FakeGroup,
  FakeProject,
  FakeProperty,
  GUARD,
  loadHost,
  MarkerValue,
  PropertyValueType,
  Shape,
  TextDocument,
  type FakeComp,
  type FakeLayer,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-w5core-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  resetSessionTracking();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const byName = (n: string) => mutateTools.find((t) => t.name === n)!;
const readTool = (n: string) => readTools.find((t) => t.name === n)!;

// ---------- a PanelHost over handlers ----------

type Handler = (args: any, script: string) => unknown;

function fakeAe(handlers: Record<string, Handler>, dir: string, project = { path: "<unsaved>", dirty: false }) {
  const calls: Array<{ fn: string; args: any }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: project.path, comp_id: args.expect?.comp_id ?? null, comp_is_valid: true, dirty: project.dirty }, durationMs: 1 };
      }
      if (fn === "status" && !handlers.status) {
        return { ok: true, result: { project_path: project.path, dirty: project.dirty }, durationMs: 1 };
      }
      const h = handlers[fn];
      if (!h) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: h(args, script), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir };
  return { ctx, calls, project, names: () => calls.map((c) => c.fn) };
}

// ---------- ae_save ----------

describe("AeSaveSchema", () => {
  const expectArg = { project_path: "<unsaved>" };
  it("takes a plain call exactly as before", () => {
    expect(AeSaveSchema.parse({ expect: expectArg })).toEqual({ expect: expectArg });
    expect(AeSaveSchema.parse({ expect: expectArg, backup: false }).backup).toBe(false);
  });

  it("takes save_as and increment, but not both", () => {
    const p = path.join(os.tmpdir(), "show.aep");
    expect(AeSaveSchema.parse({ expect: expectArg, save_as: { path: p } }).save_as?.path).toBe(p);
    expect(AeSaveSchema.parse({ expect: expectArg, increment: true }).increment).toBe(true);
    expect(() => AeSaveSchema.parse({ expect: expectArg, save_as: { path: p }, increment: true })).toThrow(/either save_as or increment/);
  });

  it("refuses a relative path, a wrong extension and a _mcp_backups folder", () => {
    expect(() => AeSaveSchema.parse({ expect: expectArg, save_as: { path: "show.aep" } })).toThrow(/absolute/);
    expect(() => AeSaveSchema.parse({ expect: expectArg, save_as: { path: path.join(os.tmpdir(), "show.txt") } })).toThrow(/\.aep/);
    expect(() => AeSaveSchema.parse({ expect: expectArg, save_as: { path: path.join(os.tmpdir(), "_mcp_backups", "show.aep") } })).toThrow(/_mcp_backups/);
    expect(saveAsPathProblem(path.join(os.tmpdir(), "Show.AEP"))).toBeNull();
  });
});

describe("nextIncrementPath and checkSaveAsTarget", () => {
  const dir = path.join(os.tmpdir(), "proj");
  it("goes from _v001 to _v002 and keeps the padding", () => {
    expect(nextIncrementPath(path.join(dir, "show_v001.aep"), ["show_v001.aep"])).toBe(path.join(dir, "show_v002.aep"));
    expect(nextIncrementPath(path.join(dir, "show_v0009.aep"), [])).toBe(path.join(dir, "show_v0010.aep"));
  });

  it("gives a name with no suffix _v002", () => {
    expect(nextIncrementPath(path.join(dir, "show.aep"), ["show.aep"])).toBe(path.join(dir, "show_v002.aep"));
  });

  it("takes one more than the highest version already in the folder, and never overwrites", () => {
    const listing = ["show_v001.aep", "show_v004.aep", "SHOW_V003.AEP", "other_v009.aep", "show_v002.aep.bak"];
    expect(nextIncrementPath(path.join(dir, "show_v001.aep"), listing)).toBe(path.join(dir, "show_v005.aep"));
    expect(nextIncrementPath(path.join(dir, "show.aep"), ["show_v002.aep"])).toBe(path.join(dir, "show_v003.aep"));
  });

  it("reads the folder when no listing is given", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "a_v001.aep"), "x");
    fs.writeFileSync(path.join(d, "a_v002.aep"), "x");
    expect(nextIncrementPath(path.join(d, "a_v001.aep"))).toBe(path.join(d, "a_v003.aep"));
  });

  it("checks the folder and an existing file", () => {
    const d = tmp();
    const target = path.join(d, "new.aep");
    expect(() => checkSaveAsTarget(target, false)).not.toThrow();
    expect(() => checkSaveAsTarget(path.join(d, "missing", "new.aep"), false)).toThrow(/does not exist/);
    fs.writeFileSync(target, "x");
    expect(() => checkSaveAsTarget(target, false)).toThrow(/already exists/);
    expect(() => checkSaveAsTarget(target, true)).not.toThrow();
  });
});

describe("ae_save save_as and increment", () => {
  const saveTool = byName("ae_save");

  /** AE with a project at `project.path`; its save handler writes the file like AE does. */
  function saveAe(dir: string, startPath: string, extra: Record<string, Handler> = {}) {
    const project = { path: startPath, dirty: true };
    const ae = fakeAe(
      {
        save: (args) => {
          if (args.save_as_path) {
            fs.writeFileSync(args.save_as_path, "AEPDATA");
            project.path = args.save_as_path;
          } else {
            fs.writeFileSync(project.path, "AEPDATA2");
          }
          project.dirty = false;
          return { project_path: project.path, dirty: false };
        },
        ...extra,
      },
      dir,
      project
    );
    return { ...ae, project };
  }

  it("a plain save sends exactly what it always sent", async () => {
    const dir = tmp();
    const aep = path.join(dir, "show.aep");
    fs.writeFileSync(aep, "OLD");
    const { ctx, calls } = saveAe(dir, aep);
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: aep } }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "save", "status"]);
    expect(calls[1].args).toEqual({ expect: { project_path: aep } });
    expect(out.backup_path).toContain("_mcp_backups");
    expect(out.receipt.matches).toBe(true);
  });

  it("refuses a plain save of an untitled project and points at save_as", async () => {
    const dir = tmp();
    const { ctx, calls } = saveAe(dir, "<unsaved>");
    await expect(saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" } }), ctx)).rejects.toThrow(/save_as: \{ path \}/);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
  });

  it("saves an untitled project to a new path and reads it back separately", async () => {
    const dir = tmp();
    const target = path.join(dir, "first.aep");
    const { ctx, calls, project } = saveAe(dir, "<unsaved>");
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, save_as: { path: target } }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "save", "status"]);
    expect(calls[1].args.save_as_path).toBe(target);
    expect(project.path).toBe(target);
    expect(out.project_path).toBe(target);
    expect(out.previous_project_path).toBe("<unsaved>");
    expect(out.project_size).toBe(7);
    expect(out.backup_path).toBeNull();
    expect(out.note).toContain("now points at");
    expect(out.receipt.matches).toBe(true);
    expect(out.receipt.after).toMatchObject({ project_path: target, dirty: false, file_written: true });
  });

  it("refuses an existing file unless overwrite is true, and backs the replaced file up", async () => {
    const dir = tmp();
    const target = path.join(dir, "taken.aep");
    fs.writeFileSync(target, "PRECIOUS");
    const { ctx, calls } = saveAe(dir, "<unsaved>");
    await expect(saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, save_as: { path: target } }), ctx)).rejects.toThrow(/already exists/);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, save_as: { path: target, overwrite: true } }), ctx);
    expect(out.backup_path).toContain("_mcp_backups");
    expect(fs.readFileSync(out.backup_path, "utf8")).toBe("PRECIOUS");
    expect(fs.readFileSync(target, "utf8")).toBe("AEPDATA");
  });

  it("refuses a missing folder before the save", async () => {
    const dir = tmp();
    const { ctx, calls } = saveAe(dir, "<unsaved>");
    await expect(
      saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, save_as: { path: path.join(dir, "nope", "x.aep") } }), ctx)
    ).rejects.toThrow(/does not exist/);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard"]);
  });

  it("increment saves the next free name beside the old file and leaves the old file alone", async () => {
    const dir = tmp();
    const v1 = path.join(dir, "show_v001.aep");
    fs.writeFileSync(v1, "V1");
    fs.writeFileSync(path.join(dir, "show_v002.aep"), "V2");
    const { ctx, calls } = saveAe(dir, v1);
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: v1 }, increment: true }), ctx);
    expect(out.project_path).toBe(path.join(dir, "show_v003.aep"));
    expect(calls[1].args.save_as_path).toBe(path.join(dir, "show_v003.aep"));
    expect(fs.readFileSync(v1, "utf8")).toBe("V1");
    expect(out.backup_path).toBeNull();
    expect(out.note).toContain("is untouched");
  });

  it("increment needs a saved project", async () => {
    const dir = tmp();
    const { ctx } = saveAe(dir, "<unsaved>");
    await expect(saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, increment: true }), ctx)).rejects.toThrow(/saved once/);
  });

  it("reports a failed read-back in the receipt instead of throwing once the save has run", async () => {
    const dir = tmp();
    const target = path.join(dir, "x.aep");
    const { ctx } = saveAe(dir, "<unsaved>", {
      status: () => {
        throw new Error("AE busy");
      },
    });
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, save_as: { path: target } }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toContain("Do not resend");
  });

  it("flags a project that does not point at the new file", async () => {
    const dir = tmp();
    const target = path.join(dir, "x.aep");
    const { ctx } = saveAe(dir, "<unsaved>", { status: () => ({ project_path: "<unsaved>", dirty: true }) });
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>" }, save_as: { path: target } }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(expect.arrayContaining(["expected.project_path", "expected.dirty"]));
  });

  it("takes a fresh baseline for the new path: the next guarded write is not a swap or a user change", async () => {
    const dir = tmp();
    const target = path.join(dir, "named.aep");
    const snapFor = (p: string): SessionSnapshot => ({
      project_path: p,
      dirty: false,
      revision: 3,
      num_items: 1,
      item_ids: [1],
      items_truncated: false,
      active_item: { id: 1, name: "Main", kind: "comp" },
      ae_version: "26.2.1",
      build: "1",
      render_queue: { num_items: 0, queued: 0, rendering: 0 },
      comps: [{ id: 1, name: "Main", num_layers: 2, selected: [], work_area_start: 0, work_area_duration: 3, time: 0, hash: "h1" }],
    });
    const project = { path: "<unsaved>", dirty: true };
    const ae = fakeAe(
      {
        save: (args) => {
          fs.writeFileSync(args.save_as_path, "AEP");
          project.path = args.save_as_path;
          project.dirty = false;
          return {};
        },
        sessionSnapshot: () => snapFor(project.path),
        getLayerProps: () => ({ property: { value: 50 } }),
        setProperty: () => ({ applied: ["value"] }),
      },
      dir,
      project
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ae.ctx.quarantine });
    t.record(snapFor("<unsaved>"), { op_id: "op_0", tool: "ae_project_session" });

    await saveTool.handler(saveTool.schema.parse({ expect: { project_path: "<unsaved>", comp_id: 1 }, save_as: { path: target } }), ae.ctx);
    expect(t.baselineFor(target)).not.toBeNull();
    expect(t.lastBaseline()?.project_path).toBe(target);
    // The save is not an undo step.
    expect(t.steps()).toEqual([]);

    const set = byName("ae_set_property");
    const out: any = await set.handler(
      set.schema.parse({ comp_id: 1, layer: { index: 1 }, path: ["Transform", "Opacity"], value: 50, expect: { project_path: target } }),
      ae.ctx
    );
    expect(out.applied).toBe(true);
    expect(out.user_changed).toBeUndefined();
    expect(getSessionTracker()!.steps().map((s) => s.tool)).toEqual(["ae_set_property"]);
  });

  it("turns the timed-save policy off when the project moves to another file, and says so", async () => {
    const dir = tmp();
    const v1 = path.join(dir, "show_v001.aep");
    fs.writeFileSync(v1, "V1");
    const { ctx } = saveAe(dir, v1);
    setAutosavePolicy(ctx, { enabled: true, project_path: v1, after_writes: 5 });
    try {
      const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: v1 }, increment: true }), ctx);
      expect(out.policy_disabled).toMatch(/timed-save policy was turned off/);
      // Already off: a second switch finds nothing to turn off.
      expect(disablePolicyForSwitch()).toBe(false);
    } finally {
      stopAutosavePolicy();
    }
  });

  it("keeps the timed-save policy when save_as writes onto the same file", async () => {
    const dir = tmp();
    const v1 = path.join(dir, "show_v001.aep");
    fs.writeFileSync(v1, "V1");
    const { ctx } = saveAe(dir, v1);
    setAutosavePolicy(ctx, { enabled: true, project_path: v1, after_writes: 5 });
    try {
      const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: v1 }, save_as: { path: v1, overwrite: true } }), ctx);
      expect(out.policy_disabled).toBeUndefined();
      // The policy is still on, so a switch finds something to turn off.
      expect(disablePolicyForSwitch()).toBe(true);
    } finally {
      stopAutosavePolicy();
    }
  });

  it("leaves a policy for another project alone, and a plain save does not touch it", async () => {
    const dir = tmp();
    const v1 = path.join(dir, "show_v001.aep");
    const other = path.join(dir, "other.aep");
    fs.writeFileSync(v1, "V1");
    const { ctx } = saveAe(dir, v1);
    setAutosavePolicy(ctx, { enabled: true, project_path: other, after_writes: 5 });
    try {
      const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: v1 }, increment: true }), ctx);
      expect(out.policy_disabled).toBeUndefined();
      expect(disablePolicyForSwitch()).toBe(true);
    } finally {
      stopAutosavePolicy();
    }
  });

  it("carries the comps touched under the old path to the new one", async () => {
    const dir = tmp();
    const v1 = path.join(dir, "show_v001.aep");
    fs.writeFileSync(v1, "V1");
    const comp = (id: number) => ({ id, name: "C" + id, num_layers: 1, selected: [], work_area_start: 0, work_area_duration: 3, time: 0, hash: "h" + id });
    const snapFor = (p: string, ids: number[]): SessionSnapshot => ({
      project_path: p, dirty: false, revision: 3, num_items: 2, item_ids: ids, items_truncated: false, active_item: null,
      ae_version: "26.2.1", build: "1", render_queue: { num_items: 0, queued: 0, rendering: 0 }, comps: ids.map(comp),
    });
    const project = { path: v1, dirty: true };
    const ae = fakeAe(
      {
        save: (args) => {
          fs.writeFileSync(args.save_as_path, "AEP");
          project.path = args.save_as_path;
          project.dirty = false;
          return {};
        },
        // AE reads back only the comps asked for.
        sessionSnapshot: (args) => snapFor(project.path, args.comp_ids ?? []),
      },
      dir,
      project
    );
    const t = installSessionTracking({ dataDir: dir, quarantine: ae.ctx.quarantine });
    t.record(snapFor(v1, [12, 30]), { op_id: "op_0", tool: "ae_set_property" });
    const out: any = await saveTool.handler(saveTool.schema.parse({ expect: { project_path: v1 }, increment: true }), ae.ctx);
    expect([...t.touchedComps(out.project_path)].sort()).toEqual([12, 30]);
    expect(t.baselineFor(out.project_path)!.comps.map((c) => c.id).sort()).toEqual([12, 30]);
  });
});

describe("core save host function", () => {
  function savedProject() {
    const project = new FakeProject();
    const saved: any[] = [];
    (project as any).save = (f?: { fsName: string }) => {
      saved.push(f ? f.fsName : null);
      if (f) project.file = { fsName: f.fsName };
      project.dirty = false;
    };
    project.dirty = true;
    return { project, saved };
  }

  it("a call with no save_as_path on an untitled project fails and never calls save()", () => {
    const { project, saved } = savedProject();
    const { A } = loadHost(project, []);
    expect(() => A.save({ expect: GUARD })).toThrow(/save_as: \{ path \}/);
    expect(saved).toEqual([]);
  });

  it("save_as_path saves under the new name and returns the new path", () => {
    const { project, saved } = savedProject();
    const { A } = loadHost(project, []);
    const res = A.save({ expect: GUARD, save_as_path: "C:/proj/new.aep" });
    expect(saved).toEqual(["C:/proj/new.aep"]);
    expect(res).toMatchObject({ project_path: "C:/proj/new.aep", dirty: false, saved_as: "C:/proj/new.aep" });
  });

  it("a plain save of a titled project calls save() with no file", () => {
    const { project, saved } = savedProject();
    project.file = { fsName: "C:/proj/a.aep" };
    const { A } = loadHost(project, []);
    A.save({ expect: { project_path: "C:/proj/a.aep" } });
    expect(saved).toEqual([null]);
  });
});

// ---------- host kits ----------

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  return { project, comp };
}

/**
 * Real AE: the layer has propertyDepth 0 and is the parentProperty of its top-level groups. The fake points
 * top-level groups at its layer group already; give every node a propertyDepth counted from there.
 */
function asRealRoot(layer: FakeLayer) {
  const proto = Object.getPrototypeOf(layer.group);
  const depthOf = (node: any): number => (node.parentProperty ? depthOf(node.parentProperty) + 1 : 0);
  if (!Object.getOwnPropertyDescriptor(proto, "propertyDepth")) {
    Object.defineProperty(proto, "propertyDepth", { get() { return depthOf(this); }, configurable: true });
  }
  const leaf = Object.getPrototypeOf(layer.transform("Opacity"));
  if (!Object.getOwnPropertyDescriptor(leaf, "propertyDepth")) {
    Object.defineProperty(leaf, "propertyDepth", { get() { return depthOf(this); }, configurable: true });
  }
  if (layer.group.props[0]?.parentProperty !== layer.group) throw new Error("fake no longer parents groups on the layer group");
}

describe("A.propertyPath and A.resolvePropertyPath", () => {
  it("round-trips transform, effect, mask and shape properties", () => {
    const { project, comp } = scene();
    const shape = comp.layers.addShape();
    asRealRoot(shape);
    const { A } = loadHost(project, []);
    const group = shape.group;

    const check = (prop: any) => {
      const made = A.propertyPath(prop);
      expect(A.resolvePropertyPath(shape, made.path)).toBe(prop);
      return made;
    };

    const opacity = shape.transform("Opacity");
    expect(check(opacity).path).toEqual(["ADBE Transform Group", "ADBE Opacity"]);
    expect(check(opacity).names).toEqual(["Transform", "Opacity"]);

    const masks = group.property("ADBE Mask Parade") as FakeGroup;
    const m1 = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const m2 = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    // Masks sit under an indexed group: by name, which is unique here.
    expect(check(m1.property("ADBE Mask Shape")).path).toEqual(["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"]);
    expect(check(m2.property("ADBE Mask Opacity")).path).toEqual(["ADBE Mask Parade", "Mask 2", "ADBE Mask Opacity"]);

    const contents = group.property("ADBE Root Vectors Group") as FakeGroup;
    const g1 = contents.addProperty("ADBE Vector Group") as FakeGroup;
    const inner = g1.property("ADBE Vectors Group") as FakeGroup;
    const rect = inner.addProperty("ADBE Vector Shape - Rect") as FakeGroup;
    const made = check(rect.property("ADBE Vector Rect Size"));
    expect(made.path).toEqual(["ADBE Root Vectors Group", "Group 1", "ADBE Vectors Group", "Rectangle Path 1", "ADBE Vector Rect Size"]);
    expect(made.indexed).toBe(false);
  });

  it("uses the index number where two siblings share a name", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addShape();
    asRealRoot(layer);
    const { A } = loadHost(project, []);
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    masks.addProperty("ADBE Mask Atom");
    const second = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    second.name = "Mask 1";
    (masks.props[0] as any).propertyIndex = 1;
    (masks.props[1] as any).propertyIndex = 2;
    const made = A.propertyPath(second.property("ADBE Mask Feather"));
    expect(made.path).toEqual(["ADBE Mask Parade", 2, "ADBE Mask Feather"]);
    expect(made.indexed).toBe(true);
    expect(A.resolvePropertyPath(layer, made.path)).toBe(second.property("ADBE Mask Feather"));
  });

  it("resolvePropertyPath fails with the path in the message", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addNull();
    const { A } = loadHost(project, []);
    expect(() => A.resolvePropertyPath(layer, ["ADBE Transform Group", "ADBE Nope"])).toThrow(/not found at "ADBE Nope"/);
  });
});

describe("A.statusDetail", () => {
  function detailScene() {
    const { project, comp } = scene();
    const a = comp.layers.addSolid([1, 0, 0], "A", 100, 100, 1);
    const b = comp.layers.addSolid([0, 1, 0], "B", 100, 100, 1);
    asRealRoot(a);
    asRealRoot(b);
    return { project, comp, a, b };
  }

  it("reports the active item, project selection, comp time and frame", () => {
    const { project, comp } = detailScene();
    const footage = project.addFootage("clip.mov", 10, 10);
    (project as any).activeItem = comp;
    (project as any).selection = [footage, comp];
    comp.time = 2.04;
    const { A } = loadHost(project, []);
    const d = A.statusDetail({});
    expect(d.active_item).toMatchObject({ id: comp.id, name: "Main", kind: "comp" });
    expect(d.project_selection.map((s: any) => [s.kind, s.parent_folder_id])).toEqual([
      ["footage", project.rootFolder.id],
      ["comp", project.rootFolder.id],
    ]);
    expect(d.active_comp).toMatchObject({ id: comp.id, time: 2.04, frame: 51, frame_rate: 25, work_area_start: 0, work_area_duration: 4 });
  });

  it("caps the project selection at 50 and says so", () => {
    const { project, comp } = detailScene();
    const many = Array.from({ length: 80 }, (_, i) => project.addFootage(`f${i}`, 1, 1));
    (project as any).activeItem = null;
    (project as any).selection = many;
    const { A } = loadHost(project, []);
    const d = A.statusDetail({});
    expect(d.active_item).toBeNull();
    expect(d.project_selection).toHaveLength(50);
    expect(d.project_selection_count).toBe(80);
    expect(d.project_selection_truncated).toBe(true);
    expect(d.hints.join(" ")).toContain("Several Project items");
    void comp;
  });

  it("lists selected properties as paths ae_set_property accepts, with their selected keys", () => {
    const { project, comp, a, b } = detailScene();
    (project as any).activeItem = comp;
    const opacity = b.transform("Opacity");
    opacity.setValueAtTime(0, 0);
    opacity.setValueAtTime(1, 100);
    opacity.setValueAtTime(2, 50);
    (opacity as any).selectedKeys = [1, 3];
    const position = a.transform("Position");
    const transformGroup = b.group.property("ADBE Transform Group");
    (comp as any).selectedLayers = [b];
    (comp as any).selectedProperties = [opacity, transformGroup, position];
    (b as any).selectedProperties = [opacity, transformGroup];
    (a as any).selectedProperties = [position];
    const { A } = loadHost(project, []);
    const d = A.statusDetail({});
    expect(d.selected_properties_count).toBe(3);
    const rows = d.selected_properties;
    expect(rows).toHaveLength(3);
    const op = rows.find((r: any) => r.match_name === "ADBE Opacity");
    expect(op).toMatchObject({ layer_id: b.id, layer_index: b.index, path: ["ADBE Transform Group", "ADBE Opacity"], is_group: false });
    expect(op.selected_keys).toEqual([
      { index: 1, time: 0 },
      { index: 3, time: 2 },
    ]);
    // Layer A was not selected, but its property was found by the second scan.
    const pos = rows.find((r: any) => r.match_name === "ADBE Position");
    expect(pos.layer_id).toBe(a.id);
    expect(rows.find((r: any) => r.match_name === "ADBE Transform Group").is_group).toBe(true);
    // Round trip for each.
    for (const r of rows) {
      const layer = r.layer_id === a.id ? a : b;
      expect(A.resolvePropertyPath(layer, r.path)).toBeTruthy();
    }
  });

  it("caps selected properties at 100 and keys at 200", () => {
    const { project, comp, a } = detailScene();
    (project as any).activeItem = comp;
    const props: any[] = [];
    for (let i = 0; i < 120; i++) {
      const p = new FakeProperty(`P${i}`, `ADBE P${i}`, PropertyValueType.OneD, 0);
      for (let k = 0; k < 4; k++) p.setValueAtTime(k, k);
      (p as any).selectedKeys = [1, 2, 3, 4];
      a.group.props.push(p);
      props.push(p);
    }
    (comp as any).selectedProperties = props;
    (comp as any).selectedLayers = [a];
    (a as any).selectedProperties = props;
    const { A } = loadHost(project, []);
    const d = A.statusDetail({});
    expect(d.selected_properties).toHaveLength(100);
    expect(d.selected_properties_truncated).toBe(true);
    const keys = d.selected_properties.reduce((n: number, r: any) => n + r.selected_keys.length, 0);
    expect(keys).toBe(200);
    expect(d.selected_keys_truncated).toBe(true);
  });

  it("reports the viewer, tool, build, language, GPU, OS and revision without touching the viewer", () => {
    const { project } = detailScene();
    let touched = 0;
    const viewer = {
      type: 2,
      maximized: false,
      views: [{}, {}],
      activeViewIndex: 1,
      setActive: () => touched++,
    };
    // AE enums are numbers; the names come from the global enum objects.
    (project as any).toolType = 3;
    (project as any).gpuAccelType = 2;
    (project as any).revision = 42;
    const { A, G } = loadHost(project, [], {
      activeViewer: viewer,
      disableRendering: false,
      buildName: "26.2 Build",
      buildNumber: 7,
      isoLanguage: "en_US",
      availableGPUAccelTypes: [2, 1],
    });
    G.ToolType = { Tool_Rotate: 2, Tool_Arrow: 3 };
    G.GpuAccelType = { CUDA: 1, METAL: 2, OPENCL: 4 };
    G.ViewerType = { VIEWER_COMPOSITION: 1, VIEWER_LAYER: 2, VIEWER_FOOTAGE: 3 };
    const d = A.statusDetail({});
    expect(d.viewer).toEqual({ type: "layer", maximized: false, view_count: 2, active_view_index: 1 });
    expect(touched).toBe(0);
    expect(d).toMatchObject({
      tool_type: "Tool_Arrow",
      rendering_disabled: false,
      build: { name: "26.2 Build", number: 7 },
      iso_language: "en_US",
      gpu: { available: ["METAL", "CUDA"], project: "METAL" },
      os: "Windows 11",
      revision: 42,
    });
    expect(d.warnings).toEqual([]);
    expect(Object.keys(d)).not.toContain("userName");
    expect(JSON.stringify(d)).not.toMatch(/machineName|userName/);
  });

  it("warns when rendering is disabled and when the UI language is not English", () => {
    const { project } = detailScene();
    const { A } = loadHost(project, [], { disableRendering: true, isoLanguage: "de_DE" });
    const d = A.statusDetail({});
    expect(d.rendering_disabled).toBe(true);
    expect(d.warnings[0]).toContain("ae_snapshot_frame");
    expect(d.hints.join(" ")).toContain("match name");
  });

  it("names the members this AE does not have instead of failing, and has no viewer", () => {
    const { project } = detailScene();
    const { A } = loadHost(project, []);
    const d = A.statusDetail({});
    expect(d.viewer).toBeNull();
    expect(d.hints.join(" ")).toContain("no active viewer");
    expect(d.missing).toEqual(
      expect.arrayContaining([
        "app.disableRendering (AE 16.0)",
        "app.isoLanguage",
        "app.availableGPUAccelTypes (AE 14.0)",
        "Project.toolType (AE 14.0)",
        "Project.revision",
        "app.project.selection",
      ])
    );
    expect(d.project_selection).toEqual([]);
  });

  it("environment_only leaves out the selection and viewer", () => {
    const { project, comp } = detailScene();
    (project as any).activeItem = comp;
    const { A } = loadHost(project, [], { isoLanguage: "en_US" });
    const d = A.statusDetail({ environment_only: true });
    expect(d.active_item).toBeUndefined();
    expect(d.viewer).toBeUndefined();
    expect(d.iso_language).toBe("en_US");
    expect(pickEnvironment(d)).toMatchObject({ iso_language: "en_US" });
    expect(Object.keys(pickEnvironment(d))).not.toContain("active_item");
  });

  it("the default A.status is unchanged", () => {
    const { project, comp } = detailScene();
    (project as any).activeItem = comp;
    (comp as any).selectedLayers = [];
    const { A } = loadHost(project, []);
    expect(Object.keys(A.status())).toEqual(["aeVersion", "project_path", "dirty", "active_comp", "selected_layers"]);
  });
});

// ---------- fonts ----------

class FakeFont {
  isSubstitute = false;
  isFromAdobeFonts = false;
  hasDesignAxes = false;
  designAxesData: any[] = [];
  fontID = 1;
  nativeFamilyName: string;
  constructor(public postScriptName: string, public familyName: string, public styleName: string, public glyphs?: string) {
    this.nativeFamilyName = familyName;
  }
  get fullName() {
    return `${this.familyName} ${this.styleName}`;
  }
  hasGlyphsFor(text: string) {
    if (this.glyphs === undefined) return true;
    return [...text].every((c) => this.glyphs!.includes(c));
  }
}

function fontsFixture() {
  const arial = new FakeFont("ArialMT", "Arial", "Regular", "abcdefghijklmnopqrstuvwxyz ABC");
  const arialBold = new FakeFont("Arial-BoldMT", "Arial", "Bold");
  const helv = new FakeFont("Helvetica-Bold", "Helvetica", "Bold");
  const sub = new FakeFont("GhostFont", "Ghost", "Regular");
  sub.isSubstitute = true;
  const variable = new FakeFont("Inter-Regular", "Inter", "Regular");
  variable.hasDesignAxes = true;
  variable.designAxesData = [{ axisTag: "wght", axisName: "Weight", minValue: 100, maxValue: 900, defaultValue: 400 }];
  const dupA = new FakeFont("Dup-Regular", "Dup", "Regular");
  dupA.isSubstitute = true;
  const dupB = new FakeFont("Dup-Regular", "Dup", "Regular");
  const all = [arial, arialBold, helv, sub, variable, dupA, dupB];
  const byPs = (ps: string) => all.filter((f) => f.postScriptName === ps);
  const fonts: any = {
    allFonts: [[arial, arialBold], [helv], [variable], [sub], [dupA, dupB]],
    getFontsByPostScriptName: (ps: string) => byPs(ps),
    getFontsByFamilyNameAndStyleName: (fam: string, st: string) => all.filter((f) => f.familyName === fam && f.styleName === st),
  };
  return { fonts, arial, dupA, dupB, all };
}

describe("A.fontsResolve", () => {
  it("finds a font by PostScript name or by family and style", () => {
    const { project } = scene();
    const { fonts } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsResolve({ postscript: "ArialMT" });
    expect(r.ok).toBe(true);
    expect(r.font).toMatchObject({ postscript: "ArialMT", family: "Arial", style: "Regular", full_name: "Arial Regular", is_substitute: false });
    expect(r.duplicates).toBe(0);
    const r2 = A.fontsResolve({ family: "Arial", style: "Bold" });
    expect(r2.font.postscript).toBe("Arial-BoldMT");
  });

  it("gives near matches when the name is unknown, case-insensitively and across native names", () => {
    const { project } = scene();
    const { fonts } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsResolve({ postscript: "Arial-Bold" });
    expect(r.ok).toBe(false);
    expect(r.candidates.map((c: any) => c.postscript)).toContain("Arial-BoldMT");
    expect(r.reason).toContain("Arial-BoldMT");
    const r2 = A.fontsResolve({ postscript: "HELVETICA" });
    expect(r2.candidates[0]).toMatchObject({ family: "Helvetica" });
  });

  it("reports a substitute as not ok, and design axes", () => {
    const { project } = scene();
    const { fonts } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const s = A.fontsResolve({ postscript: "GhostFont" });
    expect(s.ok).toBe(false);
    expect(s.reason).toContain("substitute");
    const v = A.fontsResolve({ postscript: "Inter-Regular" });
    expect(v.font.axes).toEqual([{ tag: "wght", name: "Weight", min: 100, max: 900, default: 400 }]);
  });

  it("prefers AE's primary font, then a real one over a substitute, when several share a name", () => {
    const { project } = scene();
    const { fonts, dupA, dupB } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsResolve({ postscript: "Dup-Regular" });
    expect(r.ok).toBe(true);
    expect(r.duplicates).toBe(1);
    expect(r.font.is_substitute).toBe(false);
    fonts.fontsDuplicateByPostScriptName = [[dupA, dupB]];
    const r2 = A.fontsResolve({ postscript: "Dup-Regular" });
    expect(r2.font.is_substitute).toBe(true);
    expect(r2.duplicates).toBe(1);
  });

  it("passes when this AE has no app.fonts, and rejects a call with nothing to look up", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    expect(A.fontsResolve({ postscript: "Whatever" })).toMatchObject({ ok: true, unchecked: true });
    const { fonts } = fontsFixture();
    const w = loadHost(project, [], { fonts });
    expect(w.A.fontsResolve({}).ok).toBe(false);
    expect(w.A.fontsResolve({ family: "Arial" }).ok).toBe(false);
  });

  it("bounds the near-match scan", () => {
    const { project } = scene();
    const many: FakeFont[][] = [];
    for (let i = 0; i < 400; i++) many.push(Array.from({ length: 30 }, (_, j) => new FakeFont(`Font${i}-${j}`, `Family${i}`, "Regular")));
    const fonts: any = { allFonts: many, getFontsByPostScriptName: () => [], getFontsByFamilyNameAndStyleName: () => [] };
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsResolve({ postscript: "Family7" });
    expect(r.ok).toBe(false);
    expect(r.candidates.length).toBeLessThanOrEqual(10);
    expect(r.reason).toContain("partly searched");
  });
});

describe("A.fontsGlyphCheck", () => {
  it("is true when the whole string is covered", () => {
    const { project } = scene();
    const { fonts } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsGlyphCheck("ArialMT", "abc ABC", 2000);
    expect(r.supported).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("lists the missing characters once each, by code point, and suggests the default font per script", () => {
    const { project } = scene();
    const { fonts } = fontsFixture();
    fonts.getCTScriptForString = (s: string, pref: unknown) => {
      expect(pref).toBe(1);
      return [
        { chars: "abc", ctScript: "CT_ROMAN_SCRIPT" },
        { chars: s.slice(3), ctScript: "CT_CJK_SCRIPT" },
      ];
    };
    fonts.getDefaultFontForCTScript = (sc: string) => (sc === "CT_CJK_SCRIPT" ? new FakeFont("NotoSansCJK-Regular", "Noto", "Regular") : null);
    const { A, G } = loadHost(project, [], { fonts });
    G.CTScript = { CT_ROMAN_SCRIPT: 1 };
    const r = A.fontsGlyphCheck("ArialMT", "abc\u4e2d\u6587\u4e2d\u{1F600}\n", 2000);
    expect(r.supported).toBe(false);
    expect(r.missing).toEqual(["\u4e2d", "\u6587", "\u{1F600}"]);
    expect(r.checked).toBe(6);
    expect(r.scripts.map((s: any) => s.ct_script)).toEqual(["CT_ROMAN_SCRIPT", "CT_CJK_SCRIPT"]);
    expect(r.suggested_default).toEqual([{ ct_script: "CT_CJK_SCRIPT", postscript: "NotoSansCJK-Regular" }]);
  });

  it("does not count line breaks against a font that covers the text", () => {
    const { project } = scene();
    const { arial } = fontsFixture();
    // A font with no cmap entry for CR/LF: AE line breaks are \r, captions join with \n.
    const { fonts } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsGlyphCheck("ArialMT", "abc\rdef\nABC", 2000);
    expect(r.supported).toBe(true);
    expect(r.missing).toEqual([]);
    expect(arial.hasGlyphsFor("a\r")).toBe(false);
    expect(A.fontsGlyphCheck("ArialMT", "\r\n", 2000).supported).toBe(true);
    expect(A.fontsGlyphCheck("ArialMT", "ab\u4e2d\n", 2000)).toMatchObject({ supported: false, missing: ["\u4e2d"] });
  });

  it("cuts the text at maxChars and caps the missing list at 50", () => {
    const { project } = scene();
    const { fonts } = fontsFixture();
    const { A } = loadHost(project, [], { fonts });
    const long = Array.from({ length: 120 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
    const r = A.fontsGlyphCheck("ArialMT", long, 100);
    expect(r.truncated).toBe(true);
    expect(r.missing).toHaveLength(50);
    expect(r.checked).toBe(100);
  });

  it("returns null when this AE cannot check glyphs, and takes a FontObject", () => {
    const { project } = scene();
    const { fonts, arial } = fontsFixture();
    const old: any = { postScriptName: "Old", familyName: "Old", styleName: "Regular" };
    const { A } = loadHost(project, [], { fonts });
    const r = A.fontsGlyphCheck(old, "x", 2000);
    expect(r.supported).toBeNull();
    expect(r.reason).toContain("25.1");
    expect(A.fontsGlyphCheck(arial, "abc", 2000).supported).toBe(true);
    expect(A.fontsGlyphCheck("NoSuchFont", "abc", 2000).supported).toBeNull();
  });
});

// ---------- TextDocument ----------

describe("A.textDocSerialise", () => {
  function doc() {
    const d: any = new TextDocument("Hello");
    Object.assign(d, {
      justification: "CENTER_JUSTIFY",
      tracking: 20,
      leading: 90,
      autoLeading: false,
      applyStroke: true,
      strokeColor: [0, 0, 1],
      strokeWidth: 3,
      pointText: true,
      boxText: false,
      fontCapsOption: "ALL_CAPS",
      horizontalScale: 1,
      lineOrientation: "HORIZONTAL",
    });
    d.fontObject = { postScriptName: "ArialMT", familyName: "Arial", styleName: "Regular", isSubstitute: false };
    return d;
  }

  it("without full it returns exactly the five fields core always did", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const out = A.textDocSerialise(doc(), { full: false });
    expect(Object.keys(out)).toEqual(["text", "font", "fontSize", "fillColor", "justification"]);
    expect(out).toMatchObject({ text: "Hello", font: "ArialMT", fontSize: 72, fillColor: [1, 1, 1], justification: "CENTER_JUSTIFY" });
    expect(A.textDocSerialise(doc())).toEqual(out);
  });

  it("core's own TextDocument value is the same five fields by default", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addText("Hi");
    asRealRoot(layer);
    const { A } = loadHost(project, []);
    const res = A.getLayerProps({ comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Text Properties", "ADBE Text Document"], depth: 1 });
    expect(Object.keys(res.property.value)).toEqual(["text", "font", "fontSize", "fillColor", "justification"]);
  });

  it("with full it adds every attribute, guarded by the apply flags, and the font object", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const out = A.textDocSerialise(doc(), { full: true });
    expect(out).toMatchObject({
      text: "Hello",
      strokeColor: [0, 0, 1],
      strokeWidth: 3,
      tracking: 20,
      leading: 90,
      autoLeading: false,
      pointText: true,
      boxText: false,
      fontCapsOption: "ALL_CAPS",
      horizontalScale: 1,
      lineOrientation: "HORIZONTAL",
      fontObject: { postscript: "ArialMT", family: "Arial", style: "Regular", is_substitute: false },
    });
    // Attributes this AE does not have are absent, not mixed.
    expect(out.tsume).toBeUndefined();
    expect(out.mixed).toEqual([]);
  });

  it("puts fields that throw or read undefined into mixed, and drops an unapplied fill colour", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const d = doc();
    d.applyFill = false;
    Object.defineProperty(d, "tracking", {
      get() {
        throw new Error("mixed");
      },
    });
    d.leading = undefined;
    const out = A.textDocSerialise(d, { full: true });
    expect(out.fillColor).toBeUndefined();
    expect(out.mixed).toEqual(expect.arrayContaining(["tracking", "leading"]));
    expect(out.tracking).toBeUndefined();
  });

  it("getLayerProps meta gives the full document and the font object", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addText("Hi");
    asRealRoot(layer);
    const { A } = loadHost(project, []);
    const res = A.getLayerProps({ comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Text Properties", "ADBE Text Document"], depth: 1, meta: true });
    expect(res.property.value.mixed).toBeDefined();
    expect(res.property.meta.value_type).toBe("TEXT_DOCUMENT");
  });
});

// ---------- property metadata, shapes, markers ----------

describe("A.propMeta", () => {
  it("reports the value type, units, limits and what can vary", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addNull();
    const { A } = loadHost(project, []);
    const op: any = layer.transform("Opacity");
    Object.assign(op, { unitsText: "percent", hasMin: true, minValue: 0, hasMax: true, maxValue: 100, isModified: false });
    expect(A.propMeta(op)).toEqual({
      value_type: "OneD",
      units: "percent",
      min: 0,
      max: 100,
      spatial: false,
      can_vary: true,
      can_expression: true,
      is_modified: false,
    });
    const pos: any = layer.transform("Position");
    expect(A.propMeta(pos).spatial).toBe(true);
    expect(A.propMeta(pos).min).toBeUndefined();
  });

  it("reports separation and its followers", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addNull();
    const { A } = loadHost(project, []);
    const pos: any = layer.transform("Position");
    const fx = new FakeProperty("X Position", "ADBE Position_0", PropertyValueType.OneD, 0);
    const fy = new FakeProperty("Y Position", "ADBE Position_1", PropertyValueType.OneD, 0);
    Object.assign(pos, { isSeparationLeader: true, dimensionsSeparated: true, isSeparationFollower: false, getSeparationFollower: (d: number) => [fx, fy][d] ?? null });
    expect(A.propMeta(pos).separation).toEqual({
      is_leader: true,
      dimensions_separated: true,
      is_follower: false,
      followers: [
        { dimension: 0, name: "X Position", match_name: "ADBE Position_0" },
        { dimension: 1, name: "Y Position", match_name: "ADBE Position_1" },
      ],
    });
  });

  it("reports dropdown items and the shown text on AE 26", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const p: any = new FakeProperty("Mode", "ADBE Mode", PropertyValueType.OneD, 2);
    p.propertyParameters = ["Off", "On", "Auto"];
    p.valueText = "On";
    expect(A.propMeta(p).dropdown).toEqual({ items: ["Off", "On", "Auto"], value_text: "On" });
  });

  it("getLayerProps adds meta only when asked", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addNull();
    asRealRoot(layer);
    const { A } = loadHost(project, []);
    const plain = A.getLayerProps({ comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Transform Group", "ADBE Opacity"], depth: 1 });
    expect(plain.property.meta).toBeUndefined();
    const withMeta = A.getLayerProps({ comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Transform Group", "ADBE Opacity"], depth: 1, meta: true });
    expect(withMeta.property.meta.value_type).toBe("OneD");
  });
});

describe("shape and marker values", () => {
  it("A.toShapeValue builds a Shape with zero tangents by default", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const s = A.toShapeValue({ vertices: [[0, 0], [100, 0], [100, 100]] });
    expect(s).toBeInstanceOf(Shape);
    expect(s.vertices).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect(s.inTangents).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(s.closed).toBe(true);
    expect(A.toShapeValue({ vertices: [[0, 0]], closed: false }).closed).toBe(false);
  });

  it("A.toShapeValue refuses a bad value with a clear message", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    expect(() => A.toShapeValue({})).toThrow(/needs vertices/);
    expect(() => A.toShapeValue({ vertices: [] })).toThrow(/at least one/);
    expect(() => A.toShapeValue({ vertices: [[0, 0, 0]].concat([[1]] as any) })).toThrow(/vertices\[1\] must be a 2-D point/);
    expect(() => A.toShapeValue({ vertices: [[0, 0], [1, 1]], inTangents: [[0, 0]] })).toThrow(/inTangents must have one/);
    expect(() => A.toShapeValue({ vertices: [[0, 0]], outTangents: [["a", 0]] })).toThrow(/outTangents\[0\]/);
  });

  it("A.serialiseShape caps at 500 vertices and counts feather points", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const s: any = new Shape();
    s.vertices = Array.from({ length: 700 }, (_, i) => [i, i]);
    s.inTangents = s.vertices.map(() => [0, 0]);
    s.outTangents = s.vertices.map(() => [1, 1]);
    s.featherSegLocs = [0, 1, 2];
    const out = A.serialiseShape(s);
    expect(out.vertices).toHaveLength(500);
    expect(out.truncated).toBe(true);
    expect(out.num_vertices).toBe(700);
    expect(out.feather_points).toBe(3);
    expect(out.closed).toBe(true);
  });

  it("A.toMarkerValue and A.serialiseMarker round-trip the fields", () => {
    const { project } = scene();
    const { A } = loadHost(project, []);
    const m = A.toMarkerValue({ comment: "Hit", duration: 0.5, chapter: "Ch", url: "u", label: 3 });
    expect(m).toBeInstanceOf(MarkerValue);
    const out = A.serialiseMarker(m);
    expect(out).toMatchObject({ comment: "Hit", duration: 0.5, chapter: "Ch", url: "u", label: 3 });
    expect(A.serialiseMarker(A.toMarkerValue("only a comment")).comment).toBe("only a comment");
    const withParams: any = new MarkerValue("x");
    withParams.getParameters = () => ({ a: 1 });
    expect(A.serialiseMarker(withParams).params).toEqual({ a: "1" });
  });

  it("getLayerProps gives Shape values as data only when asked, otherwise '[Shape]'", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addNull();
    asRealRoot(layer);
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    const mask = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const path_ = mask.property("ADBE Mask Shape") as FakeProperty;
    const sh = new Shape();
    sh.vertices = [[0, 0], [10, 10]];
    sh.inTangents = [[0, 0], [0, 0]];
    sh.outTangents = [[0, 0], [0, 0]];
    path_.staticValue = sh;
    const { A } = loadHost(project, []);
    // The vm's Shape differs from the fake's own class, so go through the realm's.
    const args = { comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"], depth: 1 };
    expect(A.getLayerProps(args).property.value).toMatch(/^\[/);
    const data = A.getLayerProps({ ...args, shape_values: true }).property.value;
    expect(data.vertices).toEqual([[0, 0], [10, 10]]);
    expect(data.num_vertices).toBe(2);
  });
});

describe("A.setProperty validation and writes", () => {
  function opacityScene() {
    const { project, comp } = scene();
    const layer = comp.layers.addSolid([1, 1, 1], "S", 100, 100, 1);
    asRealRoot(layer);
    const opacity: any = layer.transform("Opacity");
    Object.assign(opacity, { hasMin: true, minValue: 0, hasMax: true, maxValue: 100 });
    return { project, comp, layer, opacity };
  }
  const call = (A: any, comp: FakeComp, extra: Record<string, unknown>, p = ["ADBE Transform Group", "ADBE Opacity"]) =>
    A.setProperty({ comp_id: comp.id, layer: { index: 1 }, path: p, expect: GUARD, ...extra });

  it("sets a value as before", () => {
    const { project, comp, opacity } = opacityScene();
    const { A, undo } = loadHost(project, []);
    const res = call(A, comp, { value: 40 });
    expect(res.applied).toEqual(["value"]);
    expect(opacity.staticValue).toBe(40);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
  });

  it("refuses an out-of-range value before the undo group opens", () => {
    const { project, comp, opacity } = opacityScene();
    const { A, undo } = loadHost(project, []);
    expect(() => call(A, comp, { value: 140 })).toThrow(/accepts 100 at the highest, got 140/);
    expect(() => call(A, comp, { value: -5 })).toThrow(/accepts 0 at the lowest/);
    expect(() => call(A, comp, { keyframes: [{ time: 0, value: 10 }, { time: 1, value: 999 }] })).toThrow(/at the highest/);
    expect(undo.begun).toBe(0);
    expect(opacity.numKeys).toBe(0);
    expect(opacity.staticValue).toBe(100);
  });

  it("refuses the wrong number of dimensions or a non-number, before anything changes", () => {
    const { project, comp } = opacityScene();
    const { A, undo } = loadHost(project, []);
    expect(() => call(A, comp, { value: [1, 2] })).toThrow(/must be one number/);
    expect(() => call(A, comp, { value: [1, 2, 3, 4, 5] }, ["ADBE Transform Group", "ADBE Position"])).toThrow(/array of 2 or 3 numbers, got 5/);
    expect(() => call(A, comp, { value: 5 }, ["ADBE Transform Group", "ADBE Position"])).toThrow(/array of 2 or 3 numbers/);
    expect(() => call(A, comp, { value: [1, "a"] }, ["ADBE Transform Group", "ADBE Position"])).toThrow(/must be numbers/);
    expect(undo.begun).toBe(0);
    // Two numbers on the 3-D Position are fine, as AE keeps three dimensions on a 2D layer.
    call(A, comp, { value: [10, 20] }, ["ADBE Transform Group", "ADBE Position"]);
    expect(undo.begun).toBe(1);
  });

  it("refuses separated dimensions and a custom parameter", () => {
    const { project, comp, layer } = opacityScene();
    const { A } = loadHost(project, []);
    (layer.transform("Position") as any).dimensionsSeparated = true;
    expect(() => call(A, comp, { value: [1, 2] }, ["ADBE Transform Group", "ADBE Position"])).toThrow(/separated/);
    const custom = new FakeProperty("Cycle", "ADBE Cycle", PropertyValueType.CUSTOM_VALUE, null);
    layer.group.props.push(custom);
    expect(() => call(A, comp, { value: 1 }, ["ADBE Cycle"])).toThrow(/no value a script can set/);
  });

  it("writes a path value as a Shape, with zero tangents, and sets it on a mask", () => {
    const { project, comp, layer } = opacityScene();
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    const mask = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const { A } = loadHost(project, []);
    const res = call(A, comp, { value: { vertices: [[0, 0], [50, 0], [50, 50]], closed: true } }, ["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"]);
    expect(res.applied).toEqual(["value"]);
    const written: any = (mask.property("ADBE Mask Shape") as FakeProperty).staticValue;
    expect(written.vertices).toHaveLength(3);
    expect(written.outTangents).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it("refuses path keys with different vertex counts, and a vertex count that differs from the keys", () => {
    const { project, comp, layer } = opacityScene();
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    const mask = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const { A } = loadHost(project, []);
    const p = ["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"];
    expect(() => call(A, comp, { keyframes: [{ time: 0, value: { vertices: [[0, 0], [1, 1]] } }, { time: 1, value: { vertices: [[0, 0]] } }] }, p)).toThrow(/same number of vertices/);
    call(A, comp, { keyframes: [{ time: 0, value: { vertices: [[0, 0], [1, 1]] } }, { time: 1, value: { vertices: [[0, 0], [2, 2]] } }] }, p);
    expect((mask.property("ADBE Mask Shape") as FakeProperty).numKeys).toBe(2);
    expect(() => call(A, comp, { keyframes: [{ time: 2, value: { vertices: [[0, 0], [1, 1], [2, 2]] } }] }, p)).toThrow(/ae_path_write/);
  });

  it("warns, but writes, when a static path changes its vertex count", () => {
    const { project, comp, layer } = opacityScene();
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    const mask = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const prop = mask.property("ADBE Mask Shape") as FakeProperty;
    const old: any = new Shape();
    old.vertices = [[0, 0], [1, 1], [2, 2]];
    old.featherSegLocs = [0.5];
    prop.staticValue = old;
    const { A } = loadHost(project, []);
    const res = call(A, comp, { value: { vertices: [[0, 0], [9, 9]] } }, ["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"]);
    expect(res.warnings[0]).toContain("3 to 2 vertices");
    expect(res.warnings[0]).toContain("feather points are lost");
    expect((prop.staticValue as any).vertices).toHaveLength(2);
  });

  it("warns about feather points when a path of the same vertex count is written", () => {
    const { project, comp, layer } = opacityScene();
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    const mask = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const prop = mask.property("ADBE Mask Shape") as FakeProperty;
    const old: any = new Shape();
    old.vertices = [[0, 0], [1, 1], [2, 2], [3, 3]];
    old.featherSegLocs = [0.5, 1.5];
    prop.staticValue = old;
    const { A } = loadHost(project, []);
    const res = call(A, comp, { value: { vertices: [[0, 0], [5, 5], [6, 6], [7, 7]] } }, ["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("feather points");
    expect(res.warnings[0]).toContain("ae_path_write");
  });

  it("writes a marker as a key, and refuses it as a plain value", () => {
    const { project, comp, layer } = opacityScene();
    const { A } = loadHost(project, []);
    expect(() => call(A, comp, { value: { comment: "x" } }, ["ADBE Marker"])).toThrow(/Markers are keys/);
    call(A, comp, { keyframes: [{ time: 1, value: { comment: "Hit", duration: 0.25 } }] }, ["ADBE Marker"]);
    const marker = layer.group.property("ADBE Marker") as FakeProperty;
    expect(marker.numKeys).toBe(1);
    expect((marker.keyValue(1) as any).comment).toBe("Hit");
    expect((marker.keyValue(1) as any).duration).toBe(0.25);
  });

  it("switches an expression on or off, and does nothing when it is already so", () => {
    const { project, comp, opacity } = opacityScene();
    const { A, undo } = loadHost(project, []);
    expect(() => call(A, comp, { expression_enabled: true })).toThrow(/no expression/);
    call(A, comp, { expression: "wiggle(1, 10)" });
    expect(opacity.expression).toBe("wiggle(1, 10)");
    opacity.expressionEnabled = true; // AE switches an assigned expression on; the fake does not
    const off = call(A, comp, { expression_enabled: false });
    expect(off.applied).toEqual(["expression_enabled"]);
    expect(opacity.expressionEnabled).toBe(false);
    const begun = undo.begun;
    const again = call(A, comp, { expression_enabled: false });
    expect(again).toMatchObject({ applied: [], no_op: true });
    expect(undo.begun).toBe(begun);
  });

  it("refuses an unknown font with candidates, and lets it through with allow_substitute", () => {
    const { project, comp, layer } = opacityScene();
    void layer;
    const text = comp.layers.addText("Hi");
    asRealRoot(text);
    const { fonts } = fontsFixture();
    const { A, undo } = loadHost(project, [], { fonts });
    const path_ = ["ADBE Text Properties", "ADBE Text Document"];
    const args = { comp_id: comp.id, layer: { index: 1 }, path: path_, expect: GUARD };
    let err: any;
    try {
      A.setProperty({ ...args, value: { text: "x", font: "Arial-Bold" } });
    } catch (e) {
      err = e;
    }
    expect(err.message).toContain("is not available");
    expect(A.formatError(err).actual.candidates.map((c: any) => c.postscript)).toContain("Arial-BoldMT");
    expect(undo.begun).toBe(0);
    A.setProperty({ ...args, value: { text: "x", font: "Arial-Bold" }, allow_substitute: true });
    const doc: any = (text.group.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document")!;
    expect((doc as FakeProperty).staticValue).toMatchObject({ font: "Arial-Bold", text: "x" });
    A.setProperty({ ...args, value: { text: "y", font: "ArialMT" } });
    expect((doc as FakeProperty).staticValue).toMatchObject({ font: "ArialMT", text: "y" });
  });

  it("writes a text font unchecked when this AE has no app.fonts", () => {
    const { project, comp } = opacityScene();
    const text = comp.layers.addText("Hi");
    asRealRoot(text);
    const { A } = loadHost(project, []);
    A.setProperty({ comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Text Properties", "ADBE Text Document"], value: { font: "Whatever" }, expect: GUARD });
    expect(((text.group.property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty).staticValue).toMatchObject({ font: "Whatever" });
  });

  it("getLayerProps expression_error reads the error of an expression AE switched off", () => {
    const { project, comp, opacity } = opacityScene();
    // AE: an invalid expression string turns expressionEnabled off and keeps the error text.
    opacity.expression = "bad(";
    opacity.expressionEnabled = false;
    opacity.expressionError = "Syntax error";
    let evaluated = 0;
    opacity.valueAtTime = () => { evaluated++; return 0; };
    const { A } = loadHost(project, []);
    const res = A.getLayerProps({ comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Transform Group", "ADBE Opacity"], depth: 1, expression_error: true });
    expect(res.property.expressionEnabled).toBe(false);
    expect(res.property.expressionError).toBe("Syntax error");
    expect(evaluated).toBe(0);
  });

  it("getLayerProps value_only gives shapes and text in full for the value only, not for every key", () => {
    const { project, comp, layer } = opacityScene();
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    const mask = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    const prop = mask.property("ADBE Mask Shape") as FakeProperty;
    for (let k = 0; k < 3; k++) {
      const s: any = new Shape();
      s.vertices = [[0, 0], [k, k]];
      s.inTangents = [[0, 0], [0, 0]];
      s.outTangents = [[0, 0], [0, 0]];
      prop.setValueAtTime(k, s);
    }
    const { A } = loadHost(project, []);
    const args = { comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Mask Parade", "Mask 1", "ADBE Mask Shape"], depth: 1, shape_values: true, text_full: true };
    const full = A.getLayerProps(args);
    expect(full.property.keyframes[0].value.vertices).toBeDefined();
    expect(full.property.value.vertices).toBeDefined();
    const lean = A.getLayerProps({ ...args, value_only: true });
    expect(lean.property.value.vertices).toBeDefined();
    expect(lean.property.keyframes).toHaveLength(3);
    expect(lean.property.keyframes[0].value.vertices).toBeUndefined();
    expect(typeof lean.property.keyframes[0].value).toBe("string");
  });

  it("getLayerProps expression_error evaluates once and reads the error", () => {
    const { project, comp, opacity } = opacityScene();
    let evaluated = 0;
    opacity.expression = "bad(";
    opacity.expressionEnabled = true;
    opacity.expressionError = "";
    const real = opacity.valueAtTime.bind(opacity);
    opacity.valueAtTime = (t: number, pre: boolean) => {
      evaluated++;
      opacity.expressionError = "Function bad is undefined";
      return real(t, pre);
    };
    const { A } = loadHost(project, []);
    const args = { comp_id: comp.id, layer: { index: 1 }, path: ["ADBE Transform Group", "ADBE Opacity"], depth: 1 };
    expect(A.getLayerProps(args).property.expressionError).toBeUndefined();
    expect(evaluated).toBe(0);
    const res = A.getLayerProps({ ...args, expression_error: true });
    expect(evaluated).toBe(1);
    expect(res.property.expressionError).toBe("Function bad is undefined");
  });
});

// ---------- the tools ----------

describe("ae_status detail", () => {
  const status = readTool("ae_status");

  function statusCtx() {
    const calls: string[] = [];
    const ctx: any = {
      bridge: {
        health: async () => ({ ok: true }),
        callHost: async (fn: string) => {
          calls.push(fn);
          if (fn === "statusDetail") return { id: "x", result: { active_item: null, warnings: [] } };
          return { id: "x", result: { aeVersion: "26" } };
        },
      },
      quarantine: { list: () => [] },
    };
    return { ctx, calls };
  }

  it("parses detail and leaves the default reply unchanged", async () => {
    expect(AeStatusSchema.parse({})).toEqual({});
    expect(AeStatusSchema.parse({ detail: true }).detail).toBe(true);
    const { ctx, calls } = statusCtx();
    const out: any = await status.handler(status.schema.parse({}), ctx);
    expect(calls).toEqual(["status"]);
    expect(Object.keys(out)).toEqual(["health", "aeVersion", "quarantine"]);
  });

  it("reads the detail in a separate call", async () => {
    const { ctx, calls } = statusCtx();
    const out: any = await status.handler(status.schema.parse({ detail: true }), ctx);
    expect(calls).toEqual(["status", "statusDetail"]);
    expect(out.detail).toMatchObject({ active_item: null, warnings: [] });
    expect(out.detail.resources).toBeDefined();
    expect(out.aeVersion).toBe("26");
  });

  it("keeps the base reply when the detail read fails", async () => {
    const { ctx } = statusCtx();
    const base = ctx.bridge.callHost;
    ctx.bridge.callHost = async (fn: string, ...rest: unknown[]) => {
      if (fn === "statusDetail") throw new Error("AE busy");
      return (base as any)(fn, ...rest);
    };
    const out: any = await status.handler(status.schema.parse({ detail: true }), ctx);
    expect(out.aeVersion).toBe("26");
    expect(out.detail.error).toContain("AE busy");
  });

  it("adds detail.resources from the GPU probe, with no queue on the context, and not in the default reply", async () => {
    resetResourceCache();
    const prevRun = resourceDeps.run;
    resourceDeps.run = async () => ({
      ok: true,
      counters: true,
      adapters: [{ luid: "0", used_mb: 23000 }],
      totals: [{ name: "0", total_mb: 24000 }],
      processes: [{ pid: 4, name: "AfterFX", gpu_mb: 500 }],
    });
    try {
      const { ctx } = statusCtx();
      expect(ctx.queue).toBeUndefined();
      const out: any = await status.handler(status.schema.parse({ detail: true }), ctx);
      expect(out.detail.resources).toBeDefined();
      expect(typeof out.detail.resources.supported).toBe("boolean");
      expect(Array.isArray(out.detail.resources.warnings)).toBe(true);
      expect(out.detail.active_item).toBeNull();
      const plain: any = await status.handler(status.schema.parse({}), ctx);
      expect(plain.detail).toBeUndefined();
      expect(status.description).toContain("detail.resources");
    } finally {
      resourceDeps.run = prevRun;
      resetResourceCache();
    }
  });

  it("lists the new host functions without changing the first twelve", () => {
    expect(CORE_HOST_FUNCTIONS_WAVE5).toEqual(["statusDetail", "fontsResolve"]);
  });
});

describe("ae_get_layer_props meta", () => {
  it("passes meta and shape_values to the host only when given", async () => {
    const tool = readTool("ae_get_layer_props");
    const seen: any[] = [];
    const ctx: any = { bridge: { callHost: async (_fn: string, args: any) => (seen.push(args), { id: "x", result: {} }) } };
    await tool.handler(tool.schema.parse({ comp_id: 1, layer: { index: 1 } }), ctx);
    await tool.handler(tool.schema.parse({ comp_id: 1, layer: { index: 1 }, meta: true, shape_values: true }), ctx);
    expect(JSON.stringify(seen[0])).toBe(JSON.stringify({ comp_id: 1, layer: { index: 1 }, depth: 2 }));
    expect(seen[1]).toMatchObject({ meta: true, shape_values: true });
    expect(AeGetLayerPropsSchema.parse({ comp_id: 1, layer: { id: 3 } }).meta).toBeUndefined();
  });

  it("describes meta, the shape route and the text path options", () => {
    const d = readTool("ae_get_layer_props").description;
    expect(d).toContain("meta: true");
    expect(d).toContain("ADBE Text Path Options");
    expect(d).toContain("ae_path_write");
  });
});

describe("ae_set_property read-back", () => {
  const set = byName("ae_set_property");
  const lp = (value: unknown, extra: Record<string, unknown> = {}) => ({ property: { value, numKeys: 0, expression: "", expressionEnabled: false, ...extra } });

  function run(args: Record<string, unknown>, after: unknown, write: Record<string, unknown> = { applied: ["value"] }) {
    const dir = tmp();
    let reads = 0;
    const ae = fakeAe(
      {
        getLayerProps: () => (++reads === 1 ? lp(0) : after),
        setProperty: () => write,
      },
      dir
    );
    return { ...ae, run: () => set.handler(set.schema.parse({ comp_id: 1, layer: { index: 1 }, path: ["ADBE Transform Group", "ADBE Opacity"], expect: { project_path: "<unsaved>" }, ...args }), ae.ctx) };
  }

  it("parses the new arguments and accepts expression_enabled alone", () => {
    const ok = AeSetPropertySchema.parse({ comp_id: 1, layer: { index: 1 }, path: ["x"], expression_enabled: false, allow_substitute: true, expect: { project_path: "<unsaved>" } });
    expect(ok.expression_enabled).toBe(false);
    expect(() => AeSetPropertySchema.parse({ comp_id: 1, layer: { index: 1 }, path: ["x"], expect: { project_path: "<unsaved>" } })).toThrow(/at least one/);
  });

  it("sends the new write arguments and asks the read-backs for shape and text data", async () => {
    const t = run({ expression: "time", expression_enabled: true, allow_substitute: true }, lp(0, { expression: "time", expressionEnabled: true, expressionError: "" }));
    const out: any = await t.run();
    const write = t.calls.find((c) => c.fn === "setProperty")!;
    expect(write.args).toMatchObject({ expression: "time", expression_enabled: true, allow_substitute: true });
    const reads = t.calls.filter((c) => c.fn === "getLayerProps");
    expect(reads).toHaveLength(2);
    expect(reads[0].args).toMatchObject({ shape_values: true, text_full: true });
    expect(reads[0].args.expression_error).toBeUndefined();
    expect(reads[1].args).toMatchObject({ shape_values: true, text_full: true, expression_error: true });
    expect(out.expression_error).toBe("");
    expect(out.receipt.matches).toBe(true);
  });

  it("makes a non-empty expressionError a receipt mismatch", async () => {
    const t = run({ expression: "bad(" }, lp(0, { expression: "bad(", expressionEnabled: true, expressionError: "Function bad is undefined" }));
    const out: any = await t.run();
    expect(out.applied).toBe(true);
    expect(out.expression_error).toBe("Function bad is undefined");
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0]).toMatchObject({ path: "expressionError" });
  });

  it("reads only the value, not every key, in both read-backs", async () => {
    const t = run({ value: 5 }, lp(5));
    await t.run();
    for (const r of t.calls.filter((c) => c.fn === "getLayerProps")) expect(r.args.value_only).toBe(true);
  });

  it("makes an expression that AE switched off a receipt mismatch even with no error text", async () => {
    const t = run({ expression: "bad(" }, lp(0, { expression: "bad(", expressionEnabled: false, expressionError: "Syntax error" }));
    const out: any = await t.run();
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("expressionEnabled");
    const quiet = run({ expression: "bad(" }, lp(0, { expression: "bad(", expressionEnabled: false }));
    const out2: any = await quiet.run();
    expect(out2.receipt.matches).toBe(false);
    // Asking for it off is not a mismatch.
    const off = run({ expression: "time", expression_enabled: false }, lp(0, { expression: "time", expressionEnabled: false, expressionError: "" }));
    expect(((await off.run()) as any).receipt.matches).toBe(true);
  });

  it("accepts a path index number, as A.propertyPath emits for same-named siblings", () => {
    const { project, comp } = scene();
    const layer = comp.layers.addShape();
    asRealRoot(layer);
    const { A } = loadHost(project, []);
    const masks = layer.group.property("ADBE Mask Parade") as FakeGroup;
    masks.addProperty("ADBE Mask Atom");
    const second = masks.addProperty("ADBE Mask Atom") as FakeGroup;
    second.name = "Mask 1";
    (masks.props[0] as any).propertyIndex = 1;
    (masks.props[1] as any).propertyIndex = 2;
    const made = A.propertyPath(second.property("ADBE Mask Feather"));
    expect(made.path).toEqual(["ADBE Mask Parade", 2, "ADBE Mask Feather"]);
    const args = { comp_id: 1, layer: { index: 1 }, path: made.path, expect: { project_path: "<unsaved>" } };
    expect(AeSetPropertySchema.parse({ ...args, value: 3 }).path).toEqual(made.path);
    expect(AeGetLayerPropsSchema.parse({ comp_id: 1, layer: { index: 1 }, path: made.path }).path).toEqual(made.path);
    expect(() => AeSetPropertySchema.parse({ ...args, path: ["ADBE Mask Parade", 0], value: 3 })).toThrow();
  });

  it("does not ask for the error on a plain value write", async () => {
    const t = run({ value: 5 }, lp(5));
    const out: any = await t.run();
    expect(out.expression_error).toBeUndefined();
    expect(t.calls.filter((c) => c.fn === "getLayerProps")[1].args.expression_error).toBe(false);
    expect(out.receipt.matches).toBe(true);
  });

  it("checks a path write against the zero-tangent shape and tolerates the cut at 500 vertices", async () => {
    const shape = { vertices: [[0, 0], [10, 0]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: true, num_vertices: 2 };
    const ok = run({ value: { vertices: [[0, 0], [10, 0]] } }, lp(shape));
    expect((await ok.run() as any).receipt.matches).toBe(true);
    const wrong = run({ value: { vertices: [[0, 0], [11, 0]] } }, lp(shape));
    expect((await wrong.run() as any).receipt.matches).toBe(false);
    const big = Array.from({ length: 600 }, (_, i) => [i, i]);
    const cut = { vertices: big.slice(0, 500), inTangents: big.slice(0, 500).map(() => [0, 0]), outTangents: big.slice(0, 500).map(() => [0, 0]), closed: true, truncated: true, num_vertices: 600 };
    const t = run({ value: { vertices: big } }, lp(cut));
    expect((await t.run() as any).receipt.matches).toBe(true);
  });

  it("compares a string written to Source Text with the document's text", async () => {
    const ok = run({ value: "Hello" }, lp({ text: "Hello", font: "ArialMT" }));
    expect((await ok.run() as any).receipt.matches).toBe(true);
    const bad = run({ value: "Hello" }, lp({ text: "Other", font: "ArialMT" }));
    expect((await bad.run() as any).receipt.matches).toBe(false);
  });

  it("flags a written font that reads back as a substitute", async () => {
    const sub = run({ value: { font: "GhostFont" }, allow_substitute: true }, lp({ text: "x", font: "GhostFont", fontObject: { postscript: "GhostFont", is_substitute: true } }));
    const allowed: any = await sub.run();
    expect(allowed.font_substituted).toBe(true);
    expect(allowed.receipt.matches).toBe(true);
    const refused = run({ value: { font: "GhostFont" } }, lp({ text: "x", font: "GhostFont", fontObject: { postscript: "GhostFont", is_substitute: true } }));
    const out: any = await refused.run();
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("value.fontObject.is_substitute");
    const fine = run({ value: { font: "ArialMT" } }, lp({ text: "x", font: "ArialMT", fontObject: { postscript: "ArialMT", is_substitute: false } }));
    expect(((await fine.run()) as any).receipt.matches).toBe(true);
  });

  it("adds no undo step for a host that changed nothing", async () => {
    const dir = tmp();
    const snap: SessionSnapshot = {
      project_path: "<unsaved>", dirty: false, revision: 1, num_items: 0, item_ids: [], items_truncated: false, active_item: null,
      ae_version: "26", build: "1", render_queue: { num_items: 0, queued: 0, rendering: 0 }, comps: [],
    };
    const ae = fakeAe({ getLayerProps: () => lp(0, { expressionEnabled: false }), setProperty: () => ({ applied: [], numKeys: 0, no_op: true }), sessionSnapshot: () => snap }, dir);
    const tr = installSessionTracking({ dataDir: dir, quarantine: ae.ctx.quarantine });
    tr.record(snap, { op_id: "op_0", tool: "x" });
    const out: any = await set.handler(set.schema.parse({ comp_id: 1, layer: { index: 1 }, path: ["a"], expression_enabled: false, expect: { project_path: "<unsaved>" } }), ae.ctx);
    expect(out.applied).toBe(true);
    expect(tr.steps()).toEqual([]);
  });

  it("normaliseExpectedValue completes a three-number colour with the alpha AE reads back", () => {
    expect(normaliseExpectedValue([1, 0.5, 0], [1, 0.5, 0, 1])).toEqual([1, 0.5, 0, 1]);
    expect(normaliseExpectedValue([1, 0.5, 0], [1, 0.5, 0])).toEqual([1, 0.5, 0]);
  });

  it("normaliseExpectedValue leaves other values as given", () => {
    expect(normaliseExpectedValue(5, 5)).toBe(5);
    expect(normaliseExpectedValue([1, 2], [1, 2, 0])).toEqual([1, 2]);
    expect(normaliseExpectedValue("a", "b")).toBe("a");
    expect(normaliseExpectedValue({ comment: "x" }, { comment: "x", duration: 0 })).toEqual({ comment: "x" });
  });
});
