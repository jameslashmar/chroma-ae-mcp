/**
 * The camera tools: schemas, the lens and spread maths, the rig run against a
 * fake bridge, the receipt checks, the scene report's maths, and
 * panel/host/ext/camera.jsx under node:vm against the fake AE DOM (extended
 * here with camera properties and effects).
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
  AeCameraRigSchema,
  AeScene3dReportSchema,
  analyseScene,
  angleOfViewFromZoom,
  cameraRigMismatches,
  cameraTools,
  spreadZs,
  zoomFromLens,
  type BriefLayer,
  type CameraInfo,
  type CameraReadBack,
  type RigWritten,
  type SceneLayer,
  type SceneRead,
} from "../src/tools/ext/camera.js";
import {
  FakeGroup,
  FakeLayer,
  FakeProject,
  FakeProperty,
  GUARD,
  loadHost,
  PropertyValueType,
  type FakeComp,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => cameraTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-camera-q-"));
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

// ---------- shapes for the pure tests ----------

const camInfo = (extra: Partial<CameraInfo> = {}): CameraInfo => ({
  id: 50,
  index: 1,
  name: "Camera",
  enabled: true,
  two_node: true,
  zoom: 2666.667,
  angle_of_view: 39.6,
  dof: false,
  focus_distance: 1000,
  aperture: 0,
  blur_level: 100,
  parent_id: null,
  is_active: true,
  expressions: {},
  expression_errors: [],
  ...extra,
});

const brief = (extra: Partial<BriefLayer> & { id: number; name: string }): BriefLayer => ({
  index: 2,
  kind: "null",
  enabled: true,
  three_d: false,
  parent_id: null,
  position: [960, 540, 0],
  scale: [100, 100, 100],
  effects: [],
  ...extra,
});

const readBack = (numLayers: number, cameras: CameraInfo[] = [], layers: BriefLayer[] = []): CameraReadBack => ({
  comp: { id: 1, name: "Main", width: 1920, height: 1080, numLayers, renderer: null },
  time: 0,
  cameras,
  active_camera_id: cameras[0]?.id ?? null,
  layers,
});

const written = (extra: Partial<RigWritten> = {}): RigWritten => ({
  camera: { id: 50, index: 1, name: "Camera" },
  controller: null,
  preset: "static",
  nodes: "two",
  zoom: 2666.667,
  angle_of_view: 39.6,
  distance: 2666.667,
  controls: [],
  primary_control: null,
  expressions: {},
  spread: [],
  focus: null,
  motion: null,
  warnings: [],
  ...extra,
});

describe("lens and spread maths", () => {
  it("matches AE's default 50 mm camera and its angle of view", () => {
    expect(zoomFromLens(1920)).toBeCloseTo(2666.667, 2);
    expect(zoomFromLens(1920, { focal_length: 50 })).toBeCloseTo(2666.667, 2);
    expect(angleOfViewFromZoom(1920, zoomFromLens(1920))).toBeCloseTo(39.6, 1);
  });

  it("derives zoom from a focal length, film size, angle of view or a raw zoom", () => {
    expect(zoomFromLens(1920, { focal_length: 35 })).toBeCloseTo(1866.667, 2);
    expect(zoomFromLens(1920, { focal_length: 25, film_size: 18 })).toBeCloseTo(1920 * (25 / 18), 2);
    expect(zoomFromLens(1920, { angle_of_view: 90 })).toBeCloseTo(960, 6);
    expect(zoomFromLens(1920, { zoom: 1234 })).toBe(1234);
  });

  it("spreads Z evenly from near to far", () => {
    expect(spreadZs(0, 1000, 3)).toEqual([0, 500, 1000]);
    expect(spreadZs(200, 900, 1)).toEqual([200]);
    expect(spreadZs(0, -300, 4)).toEqual([0, -100, -200, -300]);
  });
});

describe("schemas", () => {
  const base = { comp_id: 1, expect: expectArg };

  it("take a minimal static camera", () => {
    expect(AeCameraRigSchema.safeParse(base).success).toBe(true);
  });

  it("allow one lens form only, and film_size only with focal_length", () => {
    expect(AeCameraRigSchema.safeParse({ ...base, lens: { zoom: 1000, focal_length: 50 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, lens: { film_size: 24 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, lens: { focal_length: 35, film_size: 24 } }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, lens: { angle_of_view: 180 } }).success).toBe(false);
  });

  it("refuse an orbit with one node and a motion without a preset", () => {
    expect(AeCameraRigSchema.safeParse({ ...base, preset: "orbit", nodes: "one" }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, preset: "orbit" }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, motion: { amount: 100 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, preset: "static", motion: { amount: 100 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, preset: "push_in", motion: { amount: 500 } }).success).toBe(true);
  });

  it("need a focus layer or distance but not both, and bound blur_level", () => {
    expect(AeCameraRigSchema.safeParse({ ...base, focus: {} }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, focus: { layer: { name: "A" }, distance: 5 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, focus: { layer: { name: "A" }, aperture: 20 } }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, focus: { blur_level: 2000 } }).success).toBe(false);
  });

  it("bound the spread list and require the guard", () => {
    expect(AeCameraRigSchema.safeParse({ ...base, spread: { layers: [], near: 0, far: 100 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, spread: { layers: [{ name: "A" }], near: 0, far: 100 } }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ comp_id: 1 }).success).toBe(false);
  });

  it("the report takes a comp, an optional time and camera", () => {
    expect(AeScene3dReportSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(AeScene3dReportSchema.safeParse({ comp_id: 1, time: -1 }).success).toBe(false);
    expect(AeScene3dReportSchema.safeParse({ comp_id: 1, camera: {} }).success).toBe(false);
  });

  it("the mutating tool ends with the safety guidance and the read tool does not take expect", () => {
    expect(tool("ae_camera_rig").description).toContain("IMPORTANT");
    expect(Object.keys((tool("ae_scene_3d_report").schema as typeof AeScene3dReportSchema).shape)).not.toContain("expect");
  });
});

describe("ae_camera_rig through a fake bridge", () => {
  it("guards, reads, writes, and reads back in a separate call", async () => {
    const ctrl = brief({
      id: 51,
      name: "Camera Controller",
      effects: [
        { name: "Distance", match_name: "ADBE Slider Control", value: 2666.667, num_keys: 0 },
        { name: "Push", match_name: "ADBE Slider Control", value: 0, num_keys: 2 },
      ],
    });
    const w = written({
      controller: { id: 51, index: 1, name: "Camera Controller" },
      preset: "push_in",
      controls: [
        { name: "Distance", kind: "slider", value: 2666.667 },
        { name: "Push", kind: "slider", value: 0 },
      ],
      primary_control: "Push",
      motion: { control: "Push", amount: 800, start_time: 0, duration: 2, ease: true },
    });
    const { ctx, calls } = fakeAe({
      cameraRead: [
        readBack(1),
        readBack(3, [camInfo({ expressions: { position: "[0,0,0]" } })], [ctrl]),
      ],
      cameraRig: [w],
    });
    const args = AeCameraRigSchema.parse({ comp_id: 1, preset: "push_in", motion: { amount: 800 }, expect: expectArg });
    const out = (await tool("ae_camera_rig").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "cameraRead", "cameraRig", "cameraRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(calls[3].script).toContain('"ids":[50,51]');
    expect(out.receipt.matches).toBe(true);
    expect(out.camera).toMatchObject({ id: 50, name: "Camera" });
    expect(out.is_active_camera).toBe(true);
    expect(out.controller_layer.effects).toHaveLength(2);
  });

  it("puts a failed read-back into the receipt instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-camera-q-"));
    tmpDirs.push(dir);
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    let reads = 0;
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
        if (fn === "cameraRead") {
          if (reads++ === 0) return { ok: true, result: readBack(0), durationMs: 1 };
          throw new Error("AE went away");
        }
        return { ok: true, result: written(), durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const out = (await tool("ae_camera_rig").handler(AeCameraRigSchema.parse({ comp_id: 1, expect: expectArg }), { bridge: host, queue, quarantine })) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: { path: string }) => m.path)).toContain("read_back");
  });
});

describe("cameraRigMismatches", () => {
  const args = AeCameraRigSchema.parse({ comp_id: 1, lens: { focal_length: 35 }, expect: expectArg });

  it("accepts a camera with the lens asked for", () => {
    const after = readBack(1, [camInfo({ zoom: 1866.667 })]);
    expect(cameraRigMismatches(args, readBack(0), after, written({ zoom: 1866.667 }))).toEqual([]);
  });

  it("flags a zoom that differs from the lens, the wrong node count and a missing camera", () => {
    const wrong = readBack(1, [camInfo({ zoom: 2666.667, two_node: false })]);
    expect(cameraRigMismatches(args, readBack(0), wrong, written()).map((m) => m.path)).toEqual(["camera.two_node", "camera.zoom"]);
    expect(cameraRigMismatches(args, readBack(0), readBack(1), written()).map((m) => m.path)).toEqual(["camera"]);
  });

  it("flags a layer count that did not grow and expression errors", () => {
    const after = readBack(2, [camInfo({ zoom: 1866.667, expressions: { position: "x" }, expression_errors: [{ property: "position", error: "bad" }] })]);
    const w = written({ preset: "dolly", controller: { id: 51, index: 1, name: "C" } });
    const paths = cameraRigMismatches(args, readBack(0), after, w).map((m) => m.path);
    expect(paths).toContain("camera.expressions.position");
    expect(paths).toContain("controller");
    expect(paths).not.toContain("numLayers");
  });

  it("flags a layer count that grew by less than the camera and controller", () => {
    const after = readBack(1, [camInfo({ zoom: 1866.667, expressions: { position: "x" } })], [brief({ id: 51, name: "C" })]);
    const w = written({ preset: "dolly", controller: { id: 51, index: 1, name: "C" } });
    expect(cameraRigMismatches(args, readBack(0), after, w).map((m) => m.path)).toContain("numLayers");
  });

  it("explains a spread layer missing from a capped read-back", () => {
    const a = AeCameraRigSchema.parse({ comp_id: 1, spread: { layers: [{ name: "Hero" }], near: 0, far: 0 }, expect: expectArg });
    const after = { ...readBack(2, [camInfo({ zoom: 2666.667 })]), ids_dropped: 3 };
    const mm = cameraRigMismatches(a, readBack(1), after, written({ spread: [{ id: 7, name: "Hero", z: 0, scale_factor: 1 }] }));
    expect(mm.find((m) => m.path === "spread.Hero")?.message).toMatch(/cap/);
  });

  it("checks depth of field, the focus expression and spread depth", () => {
    const a = AeCameraRigSchema.parse({ comp_id: 1, focus: { layer: { name: "Hero" }, aperture: 30 }, spread: { layers: [{ name: "Hero" }], near: 0, far: 100 }, expect: expectArg });
    const cam = camInfo({ aperture: 0 });
    const after = readBack(2, [cam], [brief({ id: 7, name: "Hero", three_d: false, position: [0, 0, 0] })]);
    const w = written({ zoom: 2666.667, spread: [{ id: 7, name: "Hero", z: 250, scale_factor: 1 }] });
    const paths = cameraRigMismatches(a, readBack(1), after, w).map((m) => m.path);
    expect(paths).toEqual(
      expect.arrayContaining(["camera.dof", "camera.expressions.focus_distance", "camera.aperture", "spread.Hero.three_d", "spread.Hero.z"])
    );
  });

  it("checks the controller sliders and that the move has two keyframes", () => {
    const a = AeCameraRigSchema.parse({ comp_id: 1, preset: "push_in", motion: { amount: 500 }, expect: expectArg });
    const w = written({
      preset: "push_in",
      controller: { id: 51, index: 1, name: "C" },
      controls: [
        { name: "Distance", kind: "slider", value: 2666.667 },
        { name: "Push", kind: "slider", value: 0 },
      ],
      motion: { control: "Push", amount: 500, start_time: 0, duration: 2, ease: true },
    });
    const ctrl = brief({ id: 51, name: "C", effects: [{ name: "Distance", match_name: "x", value: 100, num_keys: 0 }] });
    const after = readBack(3, [camInfo({ expressions: { position: "x" } })], [ctrl]);
    const paths = cameraRigMismatches(a, readBack(1), after, w).map((m) => m.path);
    expect(paths).toEqual(expect.arrayContaining(["controller.Distance", "controller.Push", "controller.Push.num_keys"]));
  });
});

// ---------- the scene report ----------

const sceneLayer = (id: number, name: string, extra: Partial<SceneLayer> = {}, pos: number[] = [960, 540, 0]): SceneLayer => ({
  index: id,
  id,
  name,
  kind: "av",
  enabled: true,
  solo: false,
  selected: false,
  three_d: true,
  parent_id: null,
  in_point: 0,
  out_point: 10,
  visible: true,
  active_at_time: true,
  rect: null,
  skip_reason: null,
  transform: {
    anchor: [0, 0, 0],
    position: pos,
    scale: [100, 100, 100],
    rotation_z: 0,
    orientation: [0, 0, 0],
    rotation_x: 0,
    rotation_y: 0,
    point_of_interest: null,
  },
  ...extra,
});

const sceneRead = (layers: SceneLayer[], extra: Partial<SceneRead> = {}): SceneRead => ({
  comp: { id: 1, name: "Main", width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 10, resolution_factor: null, renderer: "ADBE Advanced 3d" },
  time: 1,
  layers,
  total_layers: layers.length,
  truncated: false,
  active_camera_id: null,
  comp_active_camera_id: null,
  solo_active: false,
  ...extra,
});

describe("analyseScene", () => {
  it("sorts 3D layers by depth through AE's default camera and flags the one behind it", () => {
    const read = sceneRead([
      sceneLayer(1, "Mid", {}, [960, 540, 500]),
      sceneLayer(2, "Behind", {}, [960, 540, -3000]),
      sceneLayer(3, "Plane", {}, [960, 540, 0]),
      sceneLayer(4, "Flat", { three_d: false }),
    ]);
    const out = analyseScene(read);
    expect(out.camera.source).toBe("default");
    expect(out.layers_by_depth.map((l) => l.name)).toEqual(["Behind", "Plane", "Mid"]);
    expect(out.layers_by_depth[1]).toMatchObject({ depth: 2666.667, screen: [960, 540], size_ratio: 1, behind_camera: false, center_in_frame: true });
    expect(out.behind_camera.map((l) => l.name)).toEqual(["Behind"]);
    expect(out.counts).toEqual({ three_d: 3, two_d: 1, cameras: 0 });
    expect(out.notes[0]).toMatch(/default comp camera/);
  });

  it("measures from a one-node camera layer and reports a layer outside the frame", () => {
    const cam = sceneLayer(10, "Cam", { kind: "camera", camera: { zoom: 1000, two_node: false } }, [960, 540, -1000]);
    const read = sceneRead(
      [cam, sceneLayer(1, "Centre", {}, [960, 540, 0]), sceneLayer(2, "Right", {}, [4000, 540, 0]), sceneLayer(3, "Near", {}, [960, 540, -500])],
      { active_camera_id: 10 }
    );
    const out = analyseScene(read);
    expect(out.camera).toMatchObject({ source: "layer", name: "Cam", zoom: 1000 });
    expect(out.layers_by_depth.map((l) => [l.name, l.depth])).toEqual([
      ["Near", 500],
      ["Centre", 1000],
      ["Right", 1000],
    ]);
    expect(out.layers_by_depth[0].size_ratio).toBe(2);
    expect(out.outside_frame.map((l) => l.name)).toEqual(["Right"]);
  });

  it("does not flag layers that do not render", () => {
    const read = sceneRead([sceneLayer(1, "Off", { visible: false, enabled: false }, [960, 540, -5000])]);
    const out = analyseScene(read);
    expect(out.layers_by_depth[0].behind_camera).toBe(true);
    expect(out.behind_camera).toEqual([]);
  });

  it("walks a parent chain: a child of a moved 3D null inherits its depth", () => {
    const parent = sceneLayer(1, "Rig", { kind: "null" }, [960, 540, 600]);
    const child = sceneLayer(2, "Child", { parent_id: 1 }, [0, 0, 400]);
    const out = analyseScene(sceneRead([parent, child]));
    const c = out.layers_by_depth.find((l) => l.name === "Child")!;
    expect(c.world[2]).toBeCloseTo(1000, 3);
  });

  it("warns about unused cameras and depth of field that tracks nothing", () => {
    const front = sceneLayer(10, "Front", { kind: "camera", camera: { zoom: 2000, two_node: false, dof: true, focus_distance: 900, focus_expression: false } }, [960, 540, -2000]);
    const spare = sceneLayer(11, "Spare", { kind: "camera", camera: { zoom: 2000, two_node: false } }, [0, 0, -2000]);
    const out = analyseScene(sceneRead([front, spare], { active_camera_id: 10 }));
    expect(out.warnings.join("\n")).toMatch(/"Spare"/);
    expect(out.warnings.join("\n")).toMatch(/Depth of field is on for "Front".*900/);
    // Focus tied to a layer is fine.
    front.camera!.focus_expression = true;
    expect(analyseScene(sceneRead([front, spare], { active_camera_id: 10 })).warnings.join("\n")).not.toMatch(/Depth of field/);
  });

  it("can look through a camera other than the active one", () => {
    const a = sceneLayer(10, "A", { kind: "camera", camera: { zoom: 1000, two_node: false } }, [960, 540, -1000]);
    const b = sceneLayer(11, "B", { kind: "camera", camera: { zoom: 1000, two_node: false } }, [960, 540, -3000]);
    const l = sceneLayer(1, "L", {}, [960, 540, 0]);
    expect(analyseScene(sceneRead([a, b, l], { active_camera_id: 10 })).layers_by_depth[0].depth).toBe(1000);
    expect(analyseScene(sceneRead([a, b, l], { active_camera_id: 10 }), 11).layers_by_depth[0].depth).toBe(3000);
  });

  it("does not flag 3D nulls or guide layers as off-frame or behind the camera", () => {
    const nul = sceneLayer(1, "Rig", { kind: "null" }, [960, 540, -5000]);
    const guide = sceneLayer(2, "Guide", { guide: true }, [960, 540, -5000]);
    const out = analyseScene(sceneRead([nul, guide]));
    expect(out.layers_by_depth).toHaveLength(2);
    expect(out.behind_camera).toEqual([]);
    expect(out.outside_frame).toEqual([]);
  });

  it("lists the child of an auto-oriented parent as unresolved, but not an auto-oriented layer itself", () => {
    const parent = sceneLayer(1, "Path", { kind: "null", auto_orient_active: true }, [960, 540, 600]);
    const child = sceneLayer(2, "Child", { parent_id: 1 }, [0, 0, 400]);
    const own = sceneLayer(3, "Own", { auto_orient_active: true }, [960, 540, 0]);
    const out = analyseScene(sceneRead([parent, child, own]));
    expect(out.warnings.join(" ")).toMatch(/"Child" skipped: .*Auto-Orient/);
    expect(out.warnings.join(" ")).not.toMatch(/"Own" skipped/);
    expect(out.layers_by_depth.map((l) => l.name)).toContain("Own");
  });

  it("says when the list was capped", () => {
    expect(analyseScene(sceneRead([sceneLayer(1, "L")], { truncated: true, total_layers: 900 })).warnings.join("\n")).toMatch(/900 layers/);
  });
});

describe("ae_scene_3d_report through a fake bridge", () => {
  it("reads in one non-mutating call and analyses in Node", async () => {
    const cam = sceneLayer(10, "A", { kind: "camera", camera: { zoom: 1000, two_node: false } }, [960, 540, -1000]);
    const cam2 = sceneLayer(11, "B", { kind: "camera", camera: { zoom: 1000, two_node: false } }, [960, 540, -3000]);
    const read = sceneRead([cam, cam2, sceneLayer(1, "L", {}, [960, 540, 0])], { active_camera_id: 10 });
    const { ctx, calls } = fakeAe({ cameraSceneRead: [read, read] });
    const out = (await tool("ae_scene_3d_report").handler({ comp_id: 1, time: 2 }, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["cameraSceneRead"]);
    expect(calls[0].script).toContain('"time":2');
    expect(out.layers_by_depth[0].depth).toBe(1000);
    const other = (await tool("ae_scene_3d_report").handler({ comp_id: 1, camera: { name: "B" } }, ctx)) as any;
    expect(other.layers_by_depth[0].depth).toBe(3000);
  });

  it("answers not_found for a camera selector that matches nothing", async () => {
    const read = sceneRead([sceneLayer(1, "L")]);
    const { ctx } = fakeAe({ cameraSceneRead: [read] });
    const out = (await tool("ae_scene_3d_report").handler({ comp_id: 1, camera: { name: "Nope" } }, ctx)) as any;
    expect(out).toMatchObject({ ok: false, error: "not_found" });
  });
});

// ---------- camera.jsx under node:vm ----------

/** An effect parade that makes slider and angle controls, as AE's does. */
class Parade extends FakeGroup {
  constructor() {
    super("Effects", "ADBE Effect Parade", []);
  }
  addProperty(matchName: string) {
    const angle = matchName === "ADBE Angle Control";
    const fx = new FakeGroup(matchName, matchName, [new FakeProperty(angle ? "Angle" : "Slider", `${matchName}-0001`, PropertyValueType.OneD, 0)]);
    fx.parentProperty = this;
    this.props.push(fx);
    return fx;
  }
}

const AutoOrientType = { ALONG_PATH: 1, CAMERA_OR_POINT_OF_INTEREST: 2, CHARACTERS_TOWARD_CAMERA: 3, NO_AUTO_ORIENT: 4 };

function rigScene(opts: { zoomMax?: number; poiViaAnchor?: boolean; lateStart?: number } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1920, 1080, 10);
  const put = (l: FakeLayer) => {
    comp.stack.unshift(l);
    return l;
  };
  const addProps = (g: FakeGroup, props: Array<FakeProperty | FakeGroup>) => {
    for (const p of props) {
      p.parentProperty = g;
      g.props.push(p);
    }
  };
  comp.layers.addCamera = (name: string) => {
    const l = new FakeLayer(comp, name, "CameraLayer");
    if (opts.poiViaAnchor) {
      // AE 26 may keep the point of interest in the anchor stream.
      (l.transform("Anchor Point") as FakeProperty).setValue([960, 540, 0]);
    } else {
      addProps(l.group.property("ADBE Transform Group") as FakeGroup, [
        new FakeProperty("Point of Interest", "ADBE Point of Interest", PropertyValueType.ThreeD_SPATIAL, [960, 540, 0], true),
      ]);
    }
    if (opts.lateStart !== undefined) {
      l.inPoint = opts.lateStart;
      l.startTime = opts.lateStart;
    }
    const zoom = new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, 2666.667);
    if (opts.zoomMax !== undefined) Object.assign(zoom, { hasMax: true, maxValue: opts.zoomMax });
    addProps(l.group, [
      new FakeGroup("Camera Options", "ADBE Camera Options Group", [
        zoom,
        new FakeProperty("Depth of Field", "ADBE Camera Depth of Field", PropertyValueType.OneD, 0),
        new FakeProperty("Focus Distance", "ADBE Camera Focus Distance", PropertyValueType.OneD, 1000),
        new FakeProperty("Aperture", "ADBE Camera Aperture", PropertyValueType.OneD, 0),
        new FakeProperty("Blur Level", "ADBE Camera Blur Level", PropertyValueType.OneD, 100),
      ]),
    ]);
    return put(l);
  };
  const addNull = comp.layers.addNull;
  comp.layers.addNull = (dur?: number) => {
    const l = addNull(dur) as FakeLayer;
    if (opts.lateStart !== undefined) {
      l.inPoint = opts.lateStart;
      l.startTime = opts.lateStart;
    }
    const at = l.group.props.findIndex((p) => p.matchName === "ADBE Effect Parade");
    const parade = new Parade();
    parade.parentProperty = l.group;
    l.group.props[at] = parade;
    return l;
  };
  const { A, undo, G } = loadHost(project, ["camera.jsx"]);
  G.AutoOrientType = AutoOrientType;
  const plane = (name: string, x = 960, y = 540) => {
    const l = comp.layers.addSolid([1, 1, 1], name, 400, 300, 1, 10) as FakeLayer;
    (l.transform("Position") as FakeProperty).setValue([x, y, 0]);
    return l;
  };
  return { project, comp, A, undo, plane };
}

const camOf = (comp: FakeComp, name = "Camera") => comp.layer(name) as FakeLayer;
const optionValue = (l: FakeLayer, match: string) => ((l.property("ADBE Camera Options Group") as FakeGroup).property(match) as FakeProperty).value;
const transformProp = (l: FakeLayer, match: string) => (l.property("ADBE Transform Group") as FakeGroup).property(match) as FakeProperty;
const slider = (l: FakeLayer, name: string) => ((l.property("ADBE Effect Parade") as FakeGroup).property(name) as FakeGroup).property(1) as FakeProperty;

describe("camera.jsx cameraRig", () => {
  it("builds a two-node push-in with a controller, a lens and a keyframed Push", () => {
    const { comp, A, undo } = rigScene();
    const r = A.cameraRig({
      comp_id: comp.id,
      preset: "push_in",
      lens: { focal_length: 35 },
      motion: { amount: 800, start_time: 1, duration: 2 },
      expect: GUARD,
    });
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(comp.numLayers).toBe(2);
    const cam = camOf(comp);
    expect(r.camera).toMatchObject({ name: "Camera" });
    expect(r.controller).toMatchObject({ name: "Camera Controller" });
    expect(r.zoom).toBeCloseTo(1866.667, 2);
    expect(optionValue(cam, "ADBE Camera Zoom")).toBeCloseTo(1866.667, 2);
    expect((cam as any).autoOrient).toBe(AutoOrientType.CAMERA_OR_POINT_OF_INTEREST);
    // Camera sits at -Distance looking at the comp's centre.
    const placed = transformProp(cam, "ADBE Position").staticValue as number[];
    expect(placed[2]).toBeCloseTo(-1866.667, 2);
    const ex = transformProp(cam, "ADBE Position").expression;
    expect(ex).toContain('thisComp.layer("Camera Controller").effect("Distance")(1)');
    expect(ex).toContain('effect("Push")(1)');
    const ctrl = camOf(comp, "Camera Controller");
    expect(slider(ctrl, "Distance").value).toBeCloseTo(1866.667, 2);
    const push = slider(ctrl, "Push");
    expect(push.numKeys).toBe(2);
    expect([push.keyTime(1), push.keyTime(2)]).toEqual([1, 3]);
    expect([push.keyValue(1), push.keyValue(2)]).toEqual([0, 800]);
    expect(r.motion).toMatchObject({ control: "Push", ease: true });
  });

  it("builds a one-node dolly: no point-of-interest expression, a Truck slider", () => {
    const { comp, A } = rigScene();
    A.cameraRig({ comp_id: comp.id, nodes: "one", preset: "dolly", name: "Cam", expect: GUARD });
    const cam = camOf(comp, "Cam");
    expect((cam as any).autoOrient).toBe(AutoOrientType.NO_AUTO_ORIENT);
    expect(transformProp(cam, "ADBE Position").expression).toContain('effect("Truck")(1)');
    expect(transformProp(cam, "ADBE Point of Interest").expression).toBe("");
    expect(slider(camOf(comp, "Cam Controller"), "Truck").value).toBe(0);
  });

  it("a two-node dolly slides the point of interest with the camera", () => {
    const { comp, A } = rigScene();
    const r = A.cameraRig({ comp_id: comp.id, preset: "parallax", expect: GUARD });
    expect(transformProp(camOf(comp), "ADBE Point of Interest").expression).toContain('effect("Truck")(1)');
    expect(r.warnings.join(" ")).toMatch(/parallax needs layers at different depths/);
  });

  it("builds an orbit with angle controls and a custom controller name", () => {
    const { comp, A } = rigScene();
    const r = A.cameraRig({ comp_id: comp.id, preset: "orbit", distance: 2000, controller_name: "Orbit Ctrl", expect: GUARD });
    const ctrl = camOf(comp, "Orbit Ctrl");
    const parade = ctrl.property("ADBE Effect Parade") as FakeGroup;
    expect(parade.props.map((p) => [p.name, p.matchName])).toEqual([
      ["Distance", "ADBE Slider Control"],
      ["Orbit Angle", "ADBE Angle Control"],
      ["Tilt", "ADBE Angle Control"],
    ]);
    expect(slider(ctrl, "Distance").value).toBe(2000);
    const ex = transformProp(camOf(comp), "ADBE Position").expression;
    expect(ex).toContain('thisComp.layer("Orbit Ctrl")');
    expect(ex).toContain("Math.sin(a)");
    expect(r.primary_control).toBe("Orbit Angle");
    // The camera itself is placed at -Distance.
    expect(transformProp(camOf(comp), "ADBE Position").staticValue).toEqual([960, 540, -2000]);
  });

  it("a static camera has no controller and no expressions", () => {
    const { comp, A } = rigScene();
    const r = A.cameraRig({ comp_id: comp.id, lens: { angle_of_view: 90 }, distance: 1500, expect: GUARD });
    expect(comp.numLayers).toBe(1);
    expect(r.controller).toBeNull();
    expect(optionValue(camOf(comp), "ADBE Camera Zoom")).toBeCloseTo(960, 6);
    expect(transformProp(camOf(comp), "ADBE Position").staticValue).toEqual([960, 540, -1500]);
    expect(transformProp(camOf(comp), "ADBE Position").expression).toBe("");
  });

  it("ties depth of field to a layer by name, and sets aperture and blur", () => {
    const { comp, A, plane } = rigScene();
    plane("Hero \"A\"");
    const r = A.cameraRig({ comp_id: comp.id, focus: { layer: { name: 'Hero "A"' }, aperture: 25, blur_level: 150 }, expect: GUARD });
    const cam = camOf(comp);
    expect(optionValue(cam, "ADBE Camera Depth of Field")).toBe(1);
    expect(optionValue(cam, "ADBE Camera Aperture")).toBe(25);
    expect(optionValue(cam, "ADBE Camera Blur Level")).toBe(150);
    const fx = ((cam.property("ADBE Camera Options Group") as FakeGroup).property("ADBE Camera Focus Distance") as FakeProperty).expression;
    expect(fx).toBe('var t = thisComp.layer("Hero \\"A\\""); fromWorld(t.toWorld(t.anchorPoint))[2]');
    expect(fx).not.toContain("activeCamera");
    expect(r.focus.layer.name).toBe('Hero "A"');
  });

  it("sets a fixed focus distance", () => {
    const { comp, A } = rigScene();
    A.cameraRig({ comp_id: comp.id, focus: { distance: 1234 }, expect: GUARD });
    expect(optionValue(camOf(comp), "ADBE Camera Focus Distance")).toBe(1234);
    expect(optionValue(camOf(comp), "ADBE Camera Depth of Field")).toBe(1);
  });

  it("spreads layers in depth, scaled to keep their size, and makes them 3D", () => {
    const { comp, A, plane } = rigScene();
    const a = plane("Front");
    const b = plane("Mid");
    const c = plane("Back");
    const r = A.cameraRig({
      comp_id: comp.id,
      preset: "parallax",
      distance: 1000,
      spread: { layers: [{ name: "Front" }, { name: "Mid" }, { name: "Back" }], near: 0, far: 1000 },
      expect: GUARD,
    });
    expect(r.spread.map((s: { z: number }) => s.z)).toEqual([0, 500, 1000]);
    expect([a, b, c].map((l) => l.threeDLayer)).toEqual([true, true, true]);
    expect(transformProp(b, "ADBE Position").value).toEqual([960, 540, 500]);
    expect(transformProp(c, "ADBE Scale").value).toEqual([200, 200, 100]);
    expect(transformProp(a, "ADBE Scale").value).toEqual([100, 100, 100]);
    expect(r.warnings.join(" ")).not.toMatch(/parallax needs/);
  });

  it("keep_size false leaves Scale alone", () => {
    const { comp, A, plane } = rigScene();
    const a = plane("A");
    A.cameraRig({ comp_id: comp.id, spread: { layers: [{ name: "A" }], near: 400, far: 400, keep_size: false }, expect: GUARD });
    expect(transformProp(a, "ADBE Scale").value).toEqual([100, 100, 100]);
    expect(transformProp(a, "ADBE Position").value[2]).toBe(400);
  });

  it("validates before touching AE: nothing is created and no undo group opens", () => {
    const { comp, A, undo, plane } = rigScene();
    const a = plane("A");
    transformProp(a, "ADBE Position").setValueAtTime(0, [1, 1, 0]);
    plane("B");
    const before = comp.numLayers;
    const bad: Array<[object, RegExp]> = [
      [{ preset: "orbit", nodes: "one" }, /needs nodes/],
      [{ preset: "nope" }, /Unknown preset/],
      [{ lens: { focal_length: -5 } }, /focal_length/],
      [{ lens: { angle_of_view: 200 } }, /angle_of_view/],
      [{ distance: 0 }, /distance/],
      [{ motion: { amount: 5 } }, /needs a preset/],
      [{ preset: "push_in", motion: { amount: 5, duration: 0 } }, /duration/],
      [{ preset: "push_in", motion: { amount: 5, start_time: 99 } }, /past the end/],
      [{ focus: { layer: { name: "Missing" } } }, /No layer named/],
      [{ focus: { aperture: -1 } }, /aperture/],
      [{ focus: { blur_level: 5000 } }, /blur_level/],
      [{ spread: { layers: [{ name: "A" }], near: 0, far: 10 } }, /animated or expression/],
      [{ spread: { layers: [{ name: "B" }], near: -2000, far: -2000 }, distance: 1000 }, /behind the camera/],
      [{ spread: { layers: [{ name: "B" }, { name: "B" }], near: 0, far: 10 } }, /twice/],
      [{ preset: "dolly", controller_name: "A" }, /exists/],
    ];
    for (const [extra, re] of bad) {
      expect(() => A.cameraRig({ comp_id: comp.id, ...extra, expect: GUARD }), JSON.stringify(extra)).toThrow(re);
    }
    expect(comp.numLayers).toBe(before);
    expect(undo.begun).toBe(0);
  });

  it("refuses a duplicate focus target name and locked or camera spread layers", () => {
    const { comp, A, plane } = rigScene();
    plane("Twin");
    plane("Twin");
    const lock = plane("Locked");
    lock.locked = true;
    expect(() => A.cameraRig({ comp_id: comp.id, focus: { layer: { name: "Twin" } }, expect: GUARD })).toThrow(/2 layers are named/);
    expect(() => A.cameraRig({ comp_id: comp.id, spread: { layers: [{ name: "Locked" }], near: 0, far: 0 }, expect: GUARD })).toThrow(/locked/);
    A.cameraRig({ comp_id: comp.id, name: "Existing", expect: GUARD });
    expect(() => A.cameraRig({ comp_id: comp.id, spread: { layers: [{ name: "Existing" }], near: 0, far: 0 }, expect: GUARD })).toThrow(/camera layer/);
  });

  it("refuses to spread a parented layer before the undo group", () => {
    const { comp, A, undo, plane } = rigScene();
    const kid = plane("Kid");
    kid.parent = plane("Boss");
    expect(() => A.cameraRig({ comp_id: comp.id, spread: { layers: [{ name: "Kid" }], near: 0, far: 0 }, expect: GUARD })).toThrow(/has a parent/);
    expect(undo.begun).toBe(0);
  });

  it("warns that a second camera is now the active one", () => {
    const { comp, A } = rigScene();
    A.cameraRig({ comp_id: comp.id, name: "First", expect: GUARD });
    const r = A.cameraRig({ comp_id: comp.id, name: "Second", expect: GUARD });
    expect(r.warnings.join(" ")).toMatch(/1 other enabled camera/);
    expect(comp.layer(1)!.name).toBe("Second");
  });

  it("takes back the camera and controller when AE refuses a value mid-write", () => {
    const { comp, A, undo, project } = rigScene({ zoomMax: 1000 });
    const items = project.numItems;
    expect(() => A.cameraRig({ comp_id: comp.id, preset: "dolly", expect: GUARD })).toThrow(/above AE's maximum/);
    expect(comp.numLayers).toBe(0);
    expect(project.numItems).toBe(items);
    expect(undo).toEqual({ begun: 1, ended: 1 });
  });

  it("puts 3D switches, positions and scales back when a later spread layer fails", () => {
    const { comp, A, plane } = rigScene();
    const a = plane("A", 100, 200);
    const b = plane("B");
    (transformProp(b, "ADBE Position") as any).setValue = () => {
      throw new Error("boom");
    };
    expect(() => A.cameraRig({ comp_id: comp.id, preset: "dolly", spread: { layers: [{ name: "A" }, { name: "B" }], near: 0, far: 500 }, expect: GUARD })).toThrow(/boom/);
    expect(a.threeDLayer).toBe(false);
    expect(transformProp(a, "ADBE Position").value).toEqual([100, 200, 0]);
    expect(transformProp(a, "ADBE Scale").value).toEqual([100, 100, 100]);
    expect(b.threeDLayer).toBe(false);
    expect(comp.numLayers).toBe(2);
  });

  it("refuses a write when the guard doesn't match", () => {
    const { comp, A } = rigScene();
    expect(() => A.cameraRig({ comp_id: comp.id, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(comp.numLayers).toBe(0);
  });
});

describe("camera.jsx reads", () => {
  it("cameraRead lists cameras with expressions and the layers asked for, in one undo-free call", () => {
    const { comp, A, undo, plane } = rigScene();
    plane("Hero");
    const r = A.cameraRig({ comp_id: comp.id, preset: "push_in", motion: { amount: 100 }, focus: { layer: { name: "Hero" } }, expect: GUARD });
    const begun = undo.begun;
    const read = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id, ids: [r.camera.id, r.controller.id] })));
    expect(undo.begun).toBe(begun);
    expect(read.comp).toMatchObject({ width: 1920, height: 1080, numLayers: 3 });
    expect(read.cameras).toHaveLength(1);
    expect(read.cameras[0]).toMatchObject({ name: "Camera", two_node: true, dof: true, is_active: true });
    expect(Object.keys(read.cameras[0].expressions).sort()).toEqual(["focus_distance", "position"]);
    expect(read.cameras[0].angle_of_view).toBeCloseTo(39.6, 1);
    expect(read.layers.map((l: { name: string }) => l.name).sort()).toEqual(["Camera", "Camera Controller"]);
    const ctrl = read.layers.find((l: { name: string }) => l.name === "Camera Controller");
    expect(ctrl.effects.map((e: { name: string; num_keys: number }) => [e.name, e.num_keys])).toEqual([
      ["Distance", 0],
      ["Push", 2],
    ]);
  });

  it("the rig's read-back passes its own receipt checks end to end", () => {
    const { comp, A, plane } = rigScene();
    plane("Hero");
    const args = AeCameraRigSchema.parse({
      comp_id: comp.id,
      preset: "push_in",
      lens: { focal_length: 35 },
      motion: { amount: 800 },
      focus: { layer: { name: "Hero" }, aperture: 20 },
      spread: { layers: [{ name: "Hero" }], near: 300, far: 300 },
      expect: expectArg,
    });
    const before = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id })));
    const w = JSON.parse(JSON.stringify(A.cameraRig({ ...args, expect: GUARD })));
    const ids = [w.camera.id, w.controller.id, ...w.spread.map((s: { id: number }) => s.id)];
    const after = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id, ids })));
    expect(cameraRigMismatches(args, before, after, w)).toEqual([]);
  });

  it("cameraRead returns every spread layer of a 200-layer spread, and the receipt passes", () => {
    const { comp, A, plane } = rigScene();
    const names: Array<{ name: string }> = [];
    for (let i = 0; i < 200; i++) {
      plane(`P${i}`);
      names.push({ name: `P${i}` });
    }
    const args = AeCameraRigSchema.parse({ comp_id: comp.id, spread: { layers: names, near: 0, far: 1000 }, expect: expectArg });
    const before = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id })));
    const w = JSON.parse(JSON.stringify(A.cameraRig({ ...args, expect: GUARD })));
    const ids = [w.camera.id, ...(w.controller ? [w.controller.id] : []), ...w.spread.map((s: { id: number }) => s.id)];
    const after = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id, ids })));
    expect(after.layers.length).toBeGreaterThanOrEqual(201);
    expect(after.ids_dropped).toBe(0);
    expect(cameraRigMismatches(args, before, after, w)).toEqual([]);
  });

  it("cameraSceneRead flags Auto-Orient on non-camera layers", () => {
    const { comp, A, plane } = rigScene();
    const a = plane("Oriented");
    plane("Plain");
    (a as any).autoOrient = AutoOrientType.ALONG_PATH;
    (comp.layer("Plain") as any).autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    const read = JSON.parse(JSON.stringify(A.cameraSceneRead({ comp_id: comp.id })));
    const flag = (n: string) => read.layers.find((l: { name: string }) => l.name === n).auto_orient_active;
    expect(flag("Oriented")).toBe(true);
    expect(flag("Plain")).toBe(false);
  });

  it("cameraSceneRead leaves the comp's time alone and reports each layer's transform and the camera's focus state", () => {
    const { comp, A, undo, plane } = rigScene();
    plane("Hero");
    A.cameraRig({ comp_id: comp.id, focus: { layer: { name: "Hero" } }, expect: GUARD });
    comp.time = 3;
    const begun = undo.begun;
    const read = JSON.parse(JSON.stringify(A.cameraSceneRead({ comp_id: comp.id, time: 2 })));
    expect(comp.time).toBe(3);
    expect(undo.begun).toBe(begun);
    expect(read.time).toBe(2);
    expect(read.layers.map((l: { kind: string }) => l.kind).sort()).toEqual(["av", "camera"]);
    const cam = read.layers.find((l: { kind: string }) => l.kind === "camera");
    expect(cam.camera).toMatchObject({ two_node: true, dof: true, focus_expression: true });
    expect(cam.transform.point_of_interest).toEqual([960, 540, 0]);
    expect(read.active_camera_id).toBe(cam.id);
    expect(read.total_layers).toBe(2);
  });

  it("host and Node agree on a spread scene: depth order, behind-camera and out-of-frame", () => {
    const { comp, A, plane } = rigScene();
    plane("Near");
    plane("Far");
    plane("Side", 6000, 540);
    A.cameraRig({
      comp_id: comp.id,
      distance: 1000,
      lens: { zoom: 1000 },
      nodes: "one",
      spread: { layers: [{ name: "Near" }, { name: "Far" }, { name: "Side" }], near: 0, far: 1000, keep_size: false },
      expect: GUARD,
    });
    // Put the nearest layer behind the camera.
    transformProp(comp.layer("Near") as FakeLayer, "ADBE Position").setValue([960, 540, -1500]);
    const read = JSON.parse(JSON.stringify(A.cameraSceneRead({ comp_id: comp.id })));
    const out = analyseScene(read);
    expect(out.camera).toMatchObject({ source: "layer", name: "Camera", zoom: 1000 });
    expect(out.layers_by_depth.map((l) => [l.name, l.depth])).toEqual([
      ["Near", -500],
      ["Far", 1500],
      ["Side", 2000],
    ]);
    expect(out.behind_camera.map((l) => l.name)).toEqual(["Near"]);
    expect(out.outside_frame.map((l) => l.name)).toEqual(["Side"]);
  });
});

describe("camera.jsx review fixes", () => {
  it("finds the point of interest under ADBE Anchor Point and still counts two nodes", () => {
    const { comp, A } = rigScene({ poiViaAnchor: true });
    const r = A.cameraRig({ comp_id: comp.id, preset: "dolly", expect: GUARD });
    const cam = camOf(comp);
    expect(r.warnings.join(" ")).not.toMatch(/point of interest property was not found/);
    expect(transformProp(cam, "ADBE Anchor Point").expression).toContain('effect("Truck")(1)');
    const info = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id }))).cameras[0];
    expect(info.two_node).toBe(true);
    expect(info.expressions.point_of_interest).toContain("Truck");
    const scene = JSON.parse(JSON.stringify(A.cameraSceneRead({ comp_id: comp.id })));
    const t = scene.layers.find((l: { kind: string }) => l.kind === "camera").transform;
    expect(t.point_of_interest).toEqual([960, 540, 0]);
    expect(t.anchor).toEqual([0, 0, 0]);
  });

  it("a one-node camera whose POI lives under the anchor stream is still one node", () => {
    const { comp, A } = rigScene({ poiViaAnchor: true });
    A.cameraRig({ comp_id: comp.id, nodes: "one", expect: GUARD });
    expect(JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id }))).cameras[0].two_node).toBe(false);
  });

  it("refuses a two-node push-in that reaches its point of interest, but not a one-node one", () => {
    const { comp, A, undo } = rigScene();
    expect(() => A.cameraRig({ comp_id: comp.id, preset: "push_in", distance: 1000, motion: { amount: 1000 }, expect: GUARD })).toThrow(/point of interest/);
    expect(() => A.cameraRig({ comp_id: comp.id, preset: "push_in", distance: 1000, motion: { amount: 3000 }, expect: GUARD })).toThrow(/point of interest/);
    expect(comp.numLayers).toBe(0);
    expect(undo.begun).toBe(0);
    A.cameraRig({ comp_id: comp.id, preset: "push_in", distance: 1000, motion: { amount: 900 }, expect: GUARD });
    A.cameraRig({ comp_id: comp.id, name: "One", nodes: "one", preset: "push_in", distance: 1000, motion: { amount: 3000 }, expect: GUARD });
    expect(comp.numLayers).toBe(4);
  });

  it("refuses a focus target named like the new camera", () => {
    const { comp, A, undo, plane } = rigScene();
    plane("Camera");
    expect(() => A.cameraRig({ comp_id: comp.id, focus: { layer: { name: "Camera" } }, expect: GUARD })).toThrow(/like the new camera/);
    plane("Pivot");
    expect(() => A.cameraRig({ comp_id: comp.id, preset: "dolly", controller_name: "Pivot", focus: { layer: { name: "Pivot" } }, expect: GUARD })).toThrow(/exists/);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(2);
  });

  it("starts the camera and controller at 0 and runs them to the comp's end", () => {
    const { comp, A } = rigScene({ lateStart: 4 });
    A.cameraRig({ comp_id: comp.id, preset: "dolly", expect: GUARD });
    for (const name of ["Camera", "Camera Controller"]) {
      const l = camOf(comp, name);
      expect([l.startTime, l.inPoint, l.outPoint]).toEqual([0, 0, comp.duration]);
    }
  });

  it("flags a rig layer that does not cover the comp", () => {
    const args = AeCameraRigSchema.parse({ comp_id: 1, expect: expectArg });
    const late = readBack(1, [camInfo({ zoom: 2666.667, in_point: 4, out_point: 10 })]);
    late.comp.duration = 10;
    expect(cameraRigMismatches(args, readBack(0), late, written()).map((m) => m.path)).toEqual(["camera.in_point"]);
  });

  it("refuses sliders beyond +/-1,000,000 before the undo group, in the schema and the host", () => {
    const { comp, A, undo } = rigScene();
    expect(() => A.cameraRig({ comp_id: comp.id, distance: 2e6, expect: GUARD })).toThrow(/Slider Control limit/);
    expect(() => A.cameraRig({ comp_id: comp.id, preset: "dolly", distance: 1000, motion: { amount: 2e6 }, expect: GUARD })).toThrow(/motion.amount/);
    expect(undo.begun).toBe(0);
    const base = { comp_id: 1, expect: expectArg };
    expect(AeCameraRigSchema.safeParse({ ...base, distance: 2e6 }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, preset: "dolly", motion: { amount: -2e6 } }).success).toBe(false);
  });

  it("evaluates Position before reading its expression error", () => {
    const { comp, A } = rigScene();
    A.cameraRig({ comp_id: comp.id, preset: "dolly", expect: GUARD });
    const pos = transformProp(camOf(comp), "ADBE Position") as any;
    let evaluated = false;
    const orig = pos.valueAtTime.bind(pos);
    pos.valueAtTime = (...a: unknown[]) => {
      evaluated = true;
      return orig(...a);
    };
    Object.defineProperty(pos, "expressionError", { get: () => (evaluated ? "bad expression" : "") });
    const info = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id }))).cameras[0];
    expect(info.expression_errors).toEqual([{ property: "position", error: "bad expression" }]);
  });

  it("reports solo, and only counts soloed layers as rendered", () => {
    const { comp, A, plane } = rigScene();
    plane("A");
    const b = plane("B");
    (b as any).solo = true;
    const read = JSON.parse(JSON.stringify(A.cameraSceneRead({ comp_id: comp.id })));
    expect(read.solo_active).toBe(true);
    expect(read.layers.map((l: { name: string; solo: boolean }) => [l.name, l.solo])).toEqual([["B", true], ["A", false]]);
    const read2 = sceneRead([sceneLayer(1, "A", {}, [960, 540, -5000]), sceneLayer(2, "B", { solo: true }, [960, 540, -5000])], { solo_active: true });
    expect(analyseScene(read2).behind_camera.map((l) => l.name)).toEqual(["B"]);
  });

  it("warns when the active camera is past the layers read, and cameraRead says when cameras were capped", () => {
    const out = analyseScene({ ...sceneRead([sceneLayer(1, "L")]), active_camera_beyond_list: true });
    expect(out.warnings.join(" ")).toMatch(/active camera is past/);
    const { comp, A } = rigScene();
    for (let i = 0; i < 51; i++) comp.layers.addCamera(`C${i}`, [0, 0]);
    const read = JSON.parse(JSON.stringify(A.cameraRead({ comp_id: comp.id })));
    expect(read.cameras).toHaveLength(50);
    expect(read.truncated).toBe(true);
  });
});
