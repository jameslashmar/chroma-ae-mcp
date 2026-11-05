/**
 * The w5scene3d group: ae_create_layer's environment light, light options,
 * parametric meshes, vertical text and checked font; ae_camera_rig's retune of
 * an existing camera; the light and model sections of ae_scene_3d_report; and
 * the model_3d / parametric_mesh layer kinds in the report tools. Schemas, the
 * guarded flow against a fake bridge, the pure checks, and layers.jsx /
 * camera.jsx (and the classifiers) under node:vm against the fake AE DOM,
 * extended here with the members the fake lacks (LightType.ENVIRONMENT,
 * ParametricMeshType, addParametricMesh, addVerticalText, app.fonts, light and
 * camera option properties).
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
  analyseScene,
  cameraRetuneMismatches,
  cameraTools,
  type CameraInfo,
  type CameraReadBack,
  type RetuneWritten,
  type SceneLayer,
  type SceneRead,
} from "../src/tools/ext/camera.js";
import { AeCreateLayerSchema, MeshSpecSchema, createLayerMismatches, layersTools, type LayerStack, type StackLayer } from "../src/tools/ext/layers.js";
import { FakeGroup, FakeLayer, FakeProject, FakeProperty, GUARD, LightType, PropertyValueType, loadHost, type FakeComp } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const expectArg = { project_path: "<unsaved>" };
const layerTool = (name: string) => layersTools.find((t) => t.name === name)!;
const cameraTool = (name: string) => cameraTools.find((t) => t.name === name)!;

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-scene3d-q-"));
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
const stack = (layers: StackLayer[], extra: Partial<LayerStack> = {}): LayerStack => ({ comp_id: 1, name: "Main", numLayers: layers.length, layers, ...extra });
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------- schemas ----------

describe("ae_create_layer schema: lights, meshes, text", () => {
  const base = { comp_id: 1, expect: expectArg };

  it("takes an environment light with a source and options", () => {
    const ok = AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "environment", light_source: { name: "HDRI" }, light_options: { intensity: 80, color: [1, 0.9, 0.8] } });
    expect(ok.success).toBe(true);
  });

  it("refuses light_source on a light that is not an environment light, and light options on the wrong type", () => {
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "spot", light_source: { index: 2 } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "null", light_options: { intensity: 50 } }).success).toBe(false);
    // Cone options are for spot lights; shadow options are not for ambient lights (an environment light may have them).
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "point", light_options: { cone_angle: 40 } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "spot", light_options: { cone_angle: 40, casts_shadows: true } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "ambient", light_options: { casts_shadows: true } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "environment", light_options: { casts_shadows: true } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_options: {} }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_options: { falloff: 3 } }).success).toBe(false);
  });

  it("discriminates the mesh options by mesh_type", () => {
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh" }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "cube", mesh_options: { width: 200, depth: 50 }, bevel_options: { radius: 5, sides: 4 } }).success).toBe(true);
    // A field of another type, a made-up field, and a bevel on a sphere are all refused.
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "cube", mesh_options: { radius: 5 } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "sphere", mesh_options: { radius: 5, sides: 24, sliceCaps: true } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "sphere", bevel_options: { radius: 1 } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "torus", bevel_options: { radius: 1 } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "plane", mesh_options: { cornerSides: 4, cornerRadius: 10 } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "cone", bevel_options: { topRadius: 1, topSides: 2, bottomRadius: 1, bottomSides: 2 } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "cylinder", mesh_options: { topCap: true, bottomCap: false } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "cylinder", mesh_options: { topCap: 1 } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "mesh", mesh_type: "cube", mesh_options: { sides: 0 } }).success).toBe(false);
    // Mesh fields belong to mesh layers only.
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "shape", mesh_type: "cube" }).success).toBe(false);
  });

  it("exports the discriminated union for the fields of every mesh type", () => {
    expect(MeshSpecSchema.safeParse({ mesh_type: "torus", mesh_options: { ringRadius: 100, pipeRadius: 20, ringSides: 32, pipeSides: 16, caps: true } }).success).toBe(true);
    expect(MeshSpecSchema.safeParse({ mesh_type: "pyramid" }).success).toBe(false);
  });

  it("takes vertical text and a font for text layers only", () => {
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "text", text: "縦書き", orientation: "vertical", font: "ArialMT" }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "text", text: "x", font: { family: "Arial", style: "Bold" } }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "text", text: "x", font: { family: "Arial" } }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "solid", orientation: "vertical" }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "solid", font: "ArialMT" }).success).toBe(false);
  });

  it("keeps the old light types and the old defaults working", () => {
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "ambient" }).success).toBe(true);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "light", light_type: "bogus" }).success).toBe(false);
    expect(AeCreateLayerSchema.safeParse({ ...base, type: "text", box_size: [200, 100] }).success).toBe(true);
  });

  it("describes the new members and still ends with the safety guidance", () => {
    const d = layerTool("ae_create_layer").description;
    expect(d).toMatch(/environment/);
    expect(d).toMatch(/parametric mesh/i);
    expect(d).toMatch(/vertical/);
    expect(d).toMatch(/not to lose work|checkpoint|expect/i);
  });
});

describe("ae_camera_rig schema: retune", () => {
  const base = { comp_id: 1, expect: expectArg };

  it("takes camera with lens, nodes, focus and depth_of_field", () => {
    expect(AeCameraRigSchema.safeParse({ ...base, camera: { name: "Camera 1" }, lens: { focal_length: 35 } }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, camera: { index: 1 }, depth_of_field: false }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, camera: { index: 1 }, nodes: "one", at_time: 2 }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, camera: { index: 1 }, focus: { layer: { name: "Logo" }, aperture: 20, focus_area_width: 40, near_far_blur_multiplier: 2 } }).success).toBe(true);
  });

  it("refuses create-only arguments with camera, an empty retune, and a contradictory focus", () => {
    for (const extra of [{ preset: "push_in" }, { name: "X" }, { distance: 1000 }, { controller_name: "C" }, { motion: { amount: 10 } }, { spread: { layers: [{ index: 1 }], near: 0, far: 10 } }]) {
      expect(AeCameraRigSchema.safeParse({ ...base, camera: { index: 1 }, lens: { zoom: 1000 }, ...extra }).success).toBe(false);
    }
    expect(AeCameraRigSchema.safeParse({ ...base, camera: { index: 1 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, camera: { index: 1 }, depth_of_field: false, focus: { distance: 100 } }).success).toBe(false);
  });

  it("refuses retune-only arguments when building a new camera, and keeps the old schema working", () => {
    expect(AeCameraRigSchema.safeParse({ ...base, depth_of_field: true }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, at_time: 1 }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, focus: { distance: 100, focus_area_width: 5 } }).success).toBe(false);
    expect(AeCameraRigSchema.safeParse({ ...base, preset: "push_in", lens: { focal_length: 35 }, focus: { layer: { name: "A" } } }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base }).success).toBe(true);
    expect(AeCameraRigSchema.safeParse({ ...base, focus: {} }).success).toBe(false);
  });

  it("describes the retune", () => {
    expect(cameraTool("ae_camera_rig").description).toMatch(/RETUNE/);
    expect(cameraTool("ae_scene_3d_report").description).toMatch(/lights/);
  });
});

// ---------- pure checks ----------

describe("createLayerMismatches: 3D extras", () => {
  const before = stack([L(1, 10, "HDRI")]);

  it("accepts a model layer for footage and a mesh layer for a mesh", () => {
    const footage = AeCreateLayerSchema.parse({ comp_id: 1, type: "footage", item_id: 5, expect: expectArg });
    const afterModel = stack([L(1, 11, "robot.glb", { kind: "model_3d" }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(footage, before, afterModel, { id: 11 })).toEqual([]);
    const mesh = AeCreateLayerSchema.parse({ comp_id: 1, type: "mesh", mesh_type: "cube", mesh_options: { width: 200 }, expect: expectArg });
    const afterMesh = stack([L(1, 12, "Cube", { kind: "parametric_mesh", mesh: { type: "cube", options: { width: 200, height: 100 }, bevel: {} } }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(mesh, before, afterMesh, { id: 12 })).toEqual([]);
  });

  it("flags a mesh of another type, a field AE did not take, and one it did not report", () => {
    const mesh = AeCreateLayerSchema.parse({ comp_id: 1, type: "mesh", mesh_type: "cube", mesh_options: { width: 200, depth: 40 }, bevel_options: { radius: 3 }, expect: expectArg });
    const after = stack([L(1, 12, "Cube", { kind: "parametric_mesh", mesh: { type: "sphere", options: { width: 100 }, bevel: {} } }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(mesh, before, after, { id: 12 }).map((x) => x.path)).toEqual([
      "layer.mesh.type",
      "layer.mesh.options.width",
      "layer.mesh.options.depth",
      "layer.mesh.bevel.radius",
    ]);
  });

  it("checks an environment light's source and options, skipping the options the host could not set", () => {
    const light = AeCreateLayerSchema.parse({
      comp_id: 1,
      type: "light",
      light_type: "environment",
      light_source: { name: "HDRI" },
      light_options: { intensity: 80, color: [1, 0.5, 0.25] },
      expect: expectArg,
    });
    const good = stack([L(1, 12, "Light", { kind: "light", lightType: "environment", lightSource: { index: 2, id: 10, name: "HDRI" }, lightOptions: { intensity: 80, color: [1, 0.5, 0.25] } }), L(2, 10, "HDRI")]);
    const w = { id: 12, light_source_id: 10, light_options_skipped: [] };
    expect(createLayerMismatches(light, before, good, w)).toEqual([]);
    const bad = stack([L(1, 12, "Light", { kind: "light", lightType: "environment", lightSource: null, lightOptions: { intensity: 50, color: [0, 0, 0] } }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(light, before, bad, w).map((x) => x.path)).toEqual(["layer.lightSource", "layer.lightOptions.intensity", "layer.lightOptions.color"]);
    // An option the host reported skipped is not compared.
    const skipped = createLayerMismatches(light, before, bad, { ...w, light_options_skipped: ["intensity", "color"] });
    expect(skipped.map((x) => x.path)).toEqual(["layer.lightSource"]);
  });

  it("expects a point light when light_options come without a light_type, and checks nothing for a plain light", () => {
    const opts = AeCreateLayerSchema.parse({ comp_id: 1, type: "light", light_options: { intensity: 80 }, expect: expectArg });
    const at = (lightType: string) => stack([L(1, 12, "Light", { kind: "light", lightType, lightOptions: { intensity: 80 } }), L(2, 10, "HDRI")]);
    const w = { id: 12, light_options_skipped: [] };
    expect(createLayerMismatches(opts, before, at("point"), w)).toEqual([]);
    expect(createLayerMismatches(opts, before, at("spot"), w).map((x) => x.path)).toEqual(["layer.lightType"]);
    const plain = AeCreateLayerSchema.parse({ comp_id: 1, type: "light", expect: expectArg });
    const spot = stack([L(1, 12, "Light", { kind: "light", lightType: "spot" }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(plain, before, spot, { id: 12 })).toEqual([]);
  });

  it("flags a substituted or different font", () => {
    const text = AeCreateLayerSchema.parse({ comp_id: 1, type: "text", text: "Hi", font: "ArialMT", expect: expectArg });
    const w = { id: 12, font: { postscript: "ArialMT" } };
    const ok = stack([L(1, 12, "Hi", { kind: "text", text: "Hi", font: "ArialMT", fontIsSubstitute: false }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(text, before, ok, w)).toEqual([]);
    const bad = stack([L(1, 12, "Hi", { kind: "text", text: "Hi", font: "Helvetica", fontIsSubstitute: true }), L(2, 10, "HDRI")]);
    expect(createLayerMismatches(text, before, bad, w).map((x) => x.path)).toEqual(["layer.font", "layer.fontIsSubstitute"]);
  });
});

const camInfo = (extra: Partial<CameraInfo> = {}): CameraInfo => ({
  id: 50,
  index: 1,
  name: "Camera 1",
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
  num_keys: { zoom: 0, focus_distance: 0, aperture: 0, blur_level: 0 },
  ...extra,
});
const camRead = (cams: CameraInfo[], numLayers = 3): CameraReadBack => ({
  comp: { id: 1, name: "Main", width: 1920, height: 1080, numLayers, duration: 10, renderer: "ADBE Advanced 3d" },
  time: 0,
  cameras: cams,
  active_camera_id: cams[0]?.id ?? null,
  layers: [],
});
const written = (changes: RetuneWritten["changes"], extra: Partial<RetuneWritten> = {}): RetuneWritten => ({
  retune: true,
  camera: { id: 50, index: 1, name: "Camera 1" },
  controller: null,
  changes,
  keyed_at: null,
  probe: { focus_area_width: null, near_far_blur_multiplier: null },
  warnings: [],
  ...extra,
});

describe("cameraRetuneMismatches", () => {
  it("accepts each change read back, and flags the ones that did not land", () => {
    const before = camRead([camInfo()]);
    const changes: RetuneWritten["changes"] = [
      { key: "zoom", value: 1866.667, keyed: false, replaced_key: false },
      { key: "depth_of_field", value: 1, keyed: false, replaced_key: false },
      { key: "focus_expression", value: "var t = 1", keyed: false, replaced_key: false },
      { key: "aperture", value: 25, keyed: false, replaced_key: false },
      { key: "nodes", value: "one", keyed: false, replaced_key: false },
    ];
    const good = camRead([camInfo({ zoom: 1866.667, dof: true, expressions: { focus_distance: "var t = 1" }, aperture: 25, two_node: false })]);
    expect(cameraRetuneMismatches(before, good, written(changes))).toEqual([]);
    const bad = camRead([camInfo({ zoom: 2666.667, dof: false, aperture: 0 })]);
    expect(cameraRetuneMismatches(before, bad, written(changes)).map((x) => x.path)).toEqual([
      "camera.zoom",
      "camera.depth_of_field",
      "camera.focus_expression",
      "camera.aperture",
      "camera.nodes",
    ]);
  });

  it("checks a keyed change by its key count, and a fixed distance for a leftover expression", () => {
    const before = camRead([camInfo({ num_keys: { zoom: 2, focus_distance: 0, aperture: 0, blur_level: 0 } })]);
    const newKey = [{ key: "zoom" as const, value: 1000, keyed: true, replaced_key: false }];
    const at = (zoom: number) => ({ time: 2, zoom, focus_distance: 1000, aperture: 0, blur_level: 100, focus_area_width: null, near_far_blur_multiplier: null });
    const added = camRead([camInfo({ num_keys: { zoom: 3, focus_distance: 0, aperture: 0, blur_level: 0 }, values_at: at(1000) })]);
    expect(cameraRetuneMismatches(before, added, written(newKey, { keyed_at: 2 }))).toEqual([]);
    expect(cameraRetuneMismatches(before, before, written(newKey, { keyed_at: 2 })).map((x) => x.path)).toEqual(["camera.zoom.num_keys", "camera.zoom.value_at_key"]);
    const replaced = [{ key: "zoom" as const, value: 1000, keyed: true, replaced_key: true }];
    // A replaced key keeps the key count, so only the value at the keyed time tells whether the write landed.
    const replacedOk = camRead([camInfo({ num_keys: { zoom: 2, focus_distance: 0, aperture: 0, blur_level: 0 }, values_at: at(1000) })]);
    const replacedBad = camRead([camInfo({ num_keys: { zoom: 2, focus_distance: 0, aperture: 0, blur_level: 0 }, values_at: at(2666.667) })]);
    expect(cameraRetuneMismatches(before, replacedOk, written(replaced, { keyed_at: 2 }))).toEqual([]);
    expect(cameraRetuneMismatches(before, replacedBad, written(replaced, { keyed_at: 2 })).map((x) => x.path)).toEqual(["camera.zoom.value_at_key"]);
    // Keyed 26.3 options are checked too.
    const faw = [{ key: "focus_area_width" as const, value: 40, keyed: true, replaced_key: true }];
    const fawBad = camRead([camInfo({ values_at: { ...at(2666.667), focus_area_width: 12 } })]);
    expect(cameraRetuneMismatches(before, fawBad, written(faw, { keyed_at: 2 })).map((x) => x.path)).toEqual(["camera.focus_area_width.value_at_key"]);
    const fixed = [{ key: "focus_distance" as const, value: 500, keyed: false, replaced_key: false }];
    const still = camRead([camInfo({ focus_distance: 500, expressions: { focus_distance: "x" } })]);
    expect(cameraRetuneMismatches(before, still, written(fixed)).map((x) => x.path)).toEqual(["camera.expressions.focus_distance"]);
  });

  it("flags a changed layer count, a missing camera and an expression error; a no-op passes", () => {
    const before = camRead([camInfo()], 3);
    const after = camRead([camInfo({ expression_errors: [{ property: "focus_distance", error: "bad" }] })], 4);
    expect(cameraRetuneMismatches(before, after, written([])).map((x) => x.path)).toEqual(["numLayers", "camera.expressions.focus_distance"]);
    expect(cameraRetuneMismatches(before, camRead([]), written([])).map((x) => x.path)).toEqual(["camera"]);
    expect(cameraRetuneMismatches(before, camRead([]), written([], { no_op: true }))).toEqual([]);
  });
});

describe("analyseScene: lights and models", () => {
  const sl = (index: number, id: number, name: string, kind: string, extra: Partial<SceneLayer> = {}): SceneLayer =>
    ({
      index,
      id,
      name,
      kind,
      enabled: true,
      solo: false,
      selected: false,
      three_d: false,
      parent_id: null,
      in_point: 0,
      out_point: 10,
      visible: true,
      guide: false,
      active_at_time: true,
      rect: null,
      skip_reason: null,
      transform: extra.three_d
        ? { anchor: [0, 0, 0], position: [960, 540, 0], scale: [100, 100, 100], rotation_z: 0, orientation: [0, 0, 0], rotation_x: 0, rotation_y: 0, point_of_interest: null }
        : null,
      ...extra,
    }) as SceneLayer;
  const read = (layers: SceneLayer[], renderer: string | null = "ADBE Calder"): SceneRead =>
    ({
      comp: { id: 1, name: "Main", width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 10, resolution_factor: null, renderer },
      time: 0,
      layers,
      total_layers: layers.length,
      truncated: false,
      active_camera_id: null,
      comp_active_camera_id: null,
      solo_active: false,
    }) as unknown as SceneRead;
  const env = (extra: Partial<NonNullable<SceneLayer["light"]>> = {}) => ({
    type: "environment",
    source: { id: 7, name: "HDRI" },
    intensity: 100,
    color: [1, 1, 1],
    casts_shadows: null,
    cone_angle: null,
    cone_feather: null,
    shadow_darkness: null,
    ...extra,
  });

  it("lists the lights with their environment source and the model and mesh layers", () => {
    const out = analyseScene(read([sl(1, 5, "Sun", "light", { light: env() }), sl(2, 6, "robot.glb", "model_3d", { three_d: true }), sl(3, 8, "Cube", "parametric_mesh", { three_d: true }), sl(4, 7, "HDRI", "footage")]));
    expect(out.lights).toHaveLength(1);
    expect(out.lights[0]).toMatchObject({ id: 5, type: "environment", source: { id: 7, name: "HDRI" }, intensity: 100, active: true });
    expect(out.models.map((m) => [m.name, m.kind])).toEqual([
      ["robot.glb", "model_3d"],
      ["Cube", "parametric_mesh"],
    ]);
    expect(out.warnings).toEqual(expect.not.arrayContaining([expect.stringMatching(/Environment light/)]));
    // The existing counts are unchanged: lights are not 3D layers to sort.
    expect(out.counts).toEqual({ three_d: 2, two_d: 1, cameras: 0 });
  });

  it("warns about an environment light with no source, with a 3D source, and in a non-Advanced renderer", () => {
    const noSource = analyseScene(read([sl(1, 5, "Sun", "light", { light: env({ source: null }) })]));
    expect(noSource.warnings.join(" ")).toMatch(/has no light source/);
    const threeD = analyseScene(read([sl(1, 5, "Sun", "light", { light: env() }), sl(2, 7, "HDRI", "footage", { three_d: true })]));
    expect(threeD.warnings.join(" ")).toMatch(/3D layer/);
    const classic = analyseScene(read([sl(1, 5, "Sun", "light", { light: env() }), sl(2, 6, "robot.glb", "model_3d", { three_d: true })], "ADBE Ernst"));
    expect(classic.warnings.filter((w) => /not Advanced 3D/.test(w))).toHaveLength(2);
    // The Classic 3D renderer ("ADBE Advanced 3d") is not Advanced 3D either.
    const classic3d = analyseScene(read([sl(1, 5, "Sun", "light", { light: env() }), sl(2, 6, "robot.glb", "model_3d", { three_d: true })], "ADBE Advanced 3d"));
    expect(classic3d.warnings.filter((w) => /not Advanced 3D/.test(w))).toHaveLength(2);
    // A comp whose renderer can't be read gets no renderer warning.
    const unknown = analyseScene(read([sl(1, 5, "Sun", "light", { light: env() })], null));
    expect(unknown.warnings.join(" ")).not.toMatch(/Advanced 3D/);
  });
});

// ---------- through a fake bridge ----------

describe("ae_create_layer through a fake bridge", () => {
  it("reads the new environment light's source back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      layerStack: [
        stack([L(1, 10, "HDRI", { kind: "footage" })]),
        stack([L(1, 12, "Env", { kind: "light", lightType: "environment", lightSource: { index: 2, id: 10, name: "HDRI" }, lightOptions: { intensity: 75 } }), L(2, 10, "HDRI", { kind: "footage" })]),
      ],
      createLayer: [{ index: 1, id: 12, name: "Env", kind: "light", light_source_id: 10, light_options_applied: ["intensity"], light_options_skipped: [], warnings: ["The comp's renderer is not Advanced 3D"] }],
    });
    const args = AeCreateLayerSchema.parse({
      comp_id: 1,
      type: "light",
      name: "Env",
      light_type: "environment",
      light_source: { name: "HDRI" },
      light_options: { intensity: 75 },
      expect: expectArg,
    });
    const out = (await layerTool("ae_create_layer").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "layerStack", "createLayer", "layerStack"]);
    expect(calls[2].script).toContain('"light_type":"environment"');
    expect(calls[2].script).toContain('"light_source":{"name":"HDRI"}');
    expect(out.receipt.matches).toBe(true);
    expect(out.layer).toMatchObject({ id: 12, lightType: "environment" });
    expect(out.warnings).toEqual(["The comp's renderer is not Advanced 3D"]);
  });

  it("reports a source AE did not keep as a receipt mismatch, not an error", async () => {
    const { ctx } = fakeAe({
      layerStack: [stack([L(1, 10, "HDRI", { kind: "footage" })]), stack([L(1, 12, "Env", { kind: "light", lightType: "environment", lightSource: null }), L(2, 10, "HDRI", { kind: "footage" })])],
      createLayer: [{ index: 1, id: 12, name: "Env", kind: "light", light_source_id: 10, light_options_applied: [], light_options_skipped: [], warnings: [] }],
    });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "light", name: "Env", light_type: "environment", light_source: { name: "HDRI" }, expect: expectArg });
    const out = (await layerTool("ae_create_layer").handler(args, ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain("layer.lightSource");
  });

  it("builds a mesh and passes its options to the host", async () => {
    const { ctx, calls } = fakeAe({
      layerStack: [
        stack([L(1, 10, "BG")]),
        stack([L(1, 13, "Cube", { kind: "parametric_mesh", mesh: { type: "cube", options: { width: 300 }, bevel: { radius: 4 } } }), L(2, 10, "BG")]),
      ],
      createLayer: [{ index: 1, id: 13, name: "Cube", kind: "mesh", mesh_type: "cube", warnings: [] }],
    });
    const args = AeCreateLayerSchema.parse({ comp_id: 1, type: "mesh", mesh_type: "cube", mesh_options: { width: 300 }, bevel_options: { radius: 4 }, expect: expectArg });
    const out = (await layerTool("ae_create_layer").handler(args, ctx)) as any;
    expect(calls[2].script).toContain('"mesh_options":{"width":300}');
    expect(out.receipt.matches).toBe(true);
    expect(out.warnings).toBeUndefined();
  });
});

describe("ae_camera_rig retune through a fake bridge", () => {
  it("guards, reads, retunes with cameraRig and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      cameraRead: [camRead([camInfo()]), camRead([camInfo({ zoom: 1866.667, angle_of_view: 54.4 })])],
      cameraRig: [written([{ key: "zoom", value: 1866.667, keyed: false, replaced_key: false }])],
    });
    const args = AeCameraRigSchema.parse({ comp_id: 1, camera: { name: "Camera 1" }, lens: { focal_length: 35 }, expect: expectArg });
    const out = (await cameraTool("ae_camera_rig").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "cameraRead", "cameraRig", "cameraRead"]);
    expect(calls[2].script).toContain('"camera":{"name":"Camera 1"}');
    expect(calls[2].script).not.toContain('"preset"');
    expect(out.receipt.matches).toBe(true);
    expect(out.camera).toMatchObject({ id: 50, zoom: 1866.667 });
  });

  it("puts a retune that did not land into the receipt", async () => {
    const { ctx } = fakeAe({
      cameraRead: [camRead([camInfo()]), camRead([camInfo()])],
      cameraRig: [written([{ key: "aperture", value: 30, keyed: false, replaced_key: false }])],
    });
    const args = AeCameraRigSchema.parse({ comp_id: 1, camera: { index: 1 }, focus: { aperture: 30 }, expect: expectArg });
    const out = (await cameraTool("ae_camera_rig").handler(args, ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(["camera.aperture"]);
  });

  it("reads the keyed time back only in the after-read, and checks the value at that key", async () => {
    const vals = (zoom: number, time: number) => ({ time, zoom, focus_distance: 1000, aperture: 0, blur_level: 100, focus_area_width: null, near_far_blur_multiplier: null });
    const keys = (n: number) => ({ zoom: n, focus_distance: 0, aperture: 0, blur_level: 0 });
    const run = async (keyedAt: number, afterZoom: number) => {
      const { ctx, calls } = fakeAe({
        cameraRead: [camRead([camInfo({ num_keys: keys(1) })]), camRead([camInfo({ num_keys: keys(1), values_at: vals(afterZoom, keyedAt) })])],
        cameraRig: [written([{ key: "zoom", value: 1000, keyed: true, replaced_key: true }], { keyed_at: keyedAt })],
      });
      const args = AeCameraRigSchema.parse({ comp_id: 1, camera: { index: 1 }, lens: { zoom: 1000 }, at_time: keyedAt, expect: expectArg });
      const out = (await cameraTool("ae_camera_rig").handler(args, ctx)) as any;
      return { out, calls };
    };
    for (const keyedAt of [0, 2]) {
      const ok = await run(keyedAt, 1000);
      expect(ok.calls.map((c) => c.fn)).toEqual(["checkGuard", "cameraRead", "cameraRig", "cameraRead"]);
      expect(ok.calls[1].script).not.toContain("at_time");
      expect(ok.calls[3].script).toContain(`"at_time":${keyedAt}`);
      expect(ok.out.receipt.matches).toBe(true);
    }
    const bad = await run(0, 2666.667);
    expect(bad.out.receipt.mismatches.map((m: any) => m.path)).toContain("camera.zoom.value_at_key");
  });

  it("builds a new camera as before when camera is not given", async () => {
    const { ctx, calls } = fakeAe({
      cameraRead: [
        { ...camRead([], 1) },
        { ...camRead([camInfo({ id: 60, name: "Camera", two_node: true, zoom: 2666.667 })], 2), layers: [] },
      ],
      cameraRig: [
        {
          camera: { id: 60, index: 1, name: "Camera" },
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
        },
      ],
    });
    const args = AeCameraRigSchema.parse({ comp_id: 1, expect: expectArg });
    await cameraTool("ae_camera_rig").handler(args, ctx);
    expect(calls[2].script).toContain('"comp_id":1');
    expect(calls[2].script).not.toContain('"camera":{');
  });
});

// ---------- layers.jsx under node:vm ----------

const hdrOptions = () => ({
  intensity: new FakeProperty("Intensity", "ADBE Light Intensity", PropertyValueType.OneD, 100),
  color: new FakeProperty("Color", "ADBE Light Color", PropertyValueType.COLOR, [1, 1, 1, 1]),
  coneAngle: new FakeProperty("Cone Angle", "ADBE Light Cone Angle", PropertyValueType.OneD, 90),
  coneFeather: new FakeProperty("Cone Feather", "ADBE Light Cone Feather 2", PropertyValueType.OneD, 50),
  shadows: new FakeProperty("Casts Shadows", "ADBE Casts Shadows", PropertyValueType.OneD, 0),
  darkness: new FakeProperty("Shadow Darkness", "ADBE Light Shadow Darkness", PropertyValueType.OneD, 100),
  diffusion: new FakeProperty("Shadow Diffusion", "ADBE Light Shadow Diffusion", PropertyValueType.OneD, 0),
});

class FakeFont {
  isSubstitute = false;
  isFromAdobeFonts = false;
  hasDesignAxes = false;
  fontID = 1;
  nativeFamilyName: string;
  constructor(public postScriptName: string, public familyName: string, public styleName: string) {
    this.nativeFamilyName = familyName;
  }
  get fullName() {
    return `${this.familyName} ${this.styleName}`;
  }
}

function fontsObject(copies = 1) {
  const arial = new FakeFont("ArialMT", "Arial", "Regular");
  const twins = [arial];
  for (let i = 1; i < copies; i++) twins.push(new FakeFont("ArialMT", "Arial", "Regular"));
  const bold = new FakeFont("Arial-BoldMT", "Arial", "Bold");
  const ghost = new FakeFont("GhostFont", "Ghost", "Regular");
  ghost.isSubstitute = true;
  const all = [...twins, bold, ghost];
  return {
    allFonts: [[...twins, bold], [ghost]],
    getFontsByPostScriptName: (ps: string) => all.filter((f) => f.postScriptName === ps),
    getFontsByFamilyNameAndStyleName: (fam: string, st: string) => all.filter((f) => f.familyName === fam && f.styleName === st),
  };
}

interface SceneOpts {
  version?: string;
  noEnvironment?: boolean;
  noMesh?: boolean;
  noVertical?: boolean;
  noFonts?: boolean;
  noShadowDiffusion?: boolean;
  fontCopies?: number;
  intensityMax?: number;
}

function layerScene(o: SceneOpts = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1920, 1080, 10);
  const put = (l: FakeLayer) => {
    comp.stack.unshift(l);
    return l;
  };
  (comp as any).renderer = "ADBE Ernst";
  comp.layers.addLight = (name: string) => {
    const l = new FakeLayer(comp, name, "LightLayer");
    l.lightType = LightType.POINT;
    const p = hdrOptions();
    if (o.intensityMax !== undefined) Object.assign(p.intensity, { hasMax: true, maxValue: o.intensityMax });
    const props = [p.intensity, p.color, p.coneAngle, p.coneFeather, p.shadows, p.darkness];
    if (!o.noShadowDiffusion) props.push(p.diffusion);
    const g = new FakeGroup("Light Options", "ADBE Light Options Group", props);
    g.parentProperty = l.group;
    l.group.props.push(g);
    return put(l);
  };
  if (!o.noMesh) {
    comp.layers.addParametricMesh = (name: string, type: number) => {
      const l = new FakeLayer(comp, name, "ParametricMeshLayer");
      let stored: Record<string, number | boolean> = { width: 100, height: 100, depth: 100, smoothingAngle: 0, radius: 50, sides: 16, topRadius: 10, bottomRadius: 20 };
      let bevel: Record<string, number | boolean> = { radius: 0, sides: 1, topRadius: 0, topSides: 1, bottomRadius: 0, bottomSides: 1 };
      // AE hands out a copy: only an assignment commits.
      Object.defineProperty(l, "parametricMeshOptions", { get: () => ({ ...stored }), set: (v) => (stored = { ...v }) });
      Object.defineProperty(l, "parametricBevelOptions", { get: () => ({ ...bevel }), set: (v) => (bevel = { ...v }) });
      (l as any).parametricMeshType = type;
      return put(l);
    };
  }
  if (!o.noVertical) {
    comp.layers.addVerticalText = (text: string) => {
      const l = new FakeLayer(comp, text || "Text", "TextLayer");
      (l as any).vertical = true;
      return put(l);
    };
    comp.layers.addVerticalBoxText = (size: number[], text: string) => {
      const l = new FakeLayer(comp, text || "Text", "TextLayer");
      (l as any).vertical = true;
      l.rect = { left: 0, top: 0, width: size[0], height: size[1] };
      return put(l);
    };
  }
  const extra: Record<string, unknown> = {};
  if (o.version) extra.version = o.version;
  if (!o.noFonts) extra.fonts = fontsObject(o.fontCopies ?? 1);
  const { A, undo, G } = loadHost(project, ["layers.jsx"], extra);
  G.LightType = o.noEnvironment ? { ...LightType } : { ...LightType, ENVIRONMENT: 4416 };
  G.ParametricMeshType = { CUBE: 1, SPHERE: 2, PLANE: 3, TORUS: 4, CONE: 5, CYLINDER: 6 };
  const plane = (name: string, threeD = false) => {
    const l = comp.layers.addSolid([1, 1, 1], name, 400, 300, 1, 10) as FakeLayer;
    l.threeDLayer = threeD;
    return l;
  };
  return { project, comp, A, undo, plane, G };
}

const stackOfComp = (A: any, comp: FakeComp) => plain(A.layerStack({ comp_id: comp.id })) as LayerStack;
const optionOf = (l: FakeLayer, match: string) => ((l.property("ADBE Light Options Group") as FakeGroup).property(match) as FakeProperty).value;

describe("layers.jsx createLayer: environment lights", () => {
  it("creates an environment light from a 2D layer and warns about the renderer", () => {
    const { comp, A, undo, plane } = layerScene();
    plane("HDRI");
    const r = A.createLayer({ comp_id: comp.id, type: "light", name: "Env", light_type: "environment", light_source: { name: "HDRI" }, expect: GUARD });
    expect(undo).toEqual({ begun: 1, ended: 1 });
    const light = comp.layer("Env") as FakeLayer;
    expect(light.lightType).toBe(4416);
    expect((light as any).lightSource.name).toBe("HDRI");
    expect(r.light_source_id).toBe((comp.layer("HDRI") as FakeLayer).id);
    expect(r.warnings.join(" ")).toMatch(/not Advanced 3D/);
    const entry = stackOfComp(A, comp).layers[0];
    expect(entry).toMatchObject({ kind: "light", lightType: "environment", lightSource: { name: "HDRI" } });
  });

  it("stays quiet about the renderer when it is Advanced 3D, and warns when there is no source", () => {
    const { comp, A } = layerScene();
    (comp as any).renderer = "ADBE Calder";
    const r = A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", expect: GUARD });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/no image/);
  });

  it("warns for the Classic 3D renderer (ADBE Advanced 3d), which is not Advanced 3D", () => {
    const { comp, A, plane } = layerScene();
    plane("HDRI");
    (comp as any).renderer = "ADBE Advanced 3d";
    const r = A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "HDRI" }, expect: GUARD });
    expect(r.warnings.join(" ")).toMatch(/not Advanced 3D.*3D Renderer tab/);
  });

  it("refuses a 3D source, a camera source and a missing source layer before the undo group", () => {
    const { comp, A, undo, plane } = layerScene();
    plane("Flat3D", true);
    const cam = new FakeLayer(comp, "Cam", "CameraLayer");
    comp.stack.unshift(cam);
    const n = comp.numLayers;
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Flat3D" }, expect: GUARD })).toThrow(/3D layer/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Cam" }, expect: GUARD })).toThrow(/camera layer/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Nope" }, expect: GUARD })).toThrow(/No layer named/);
    expect(comp.numLayers).toBe(n);
    expect(undo.begun).toBe(0);
  });

  it("refuses on an AE without LightType.ENVIRONMENT, and light_source on another light type", () => {
    const { comp, A, undo, plane } = layerScene({ noEnvironment: true });
    plane("HDRI");
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", expect: GUARD })).toThrow(/24\.3/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "spot", light_source: { name: "HDRI" }, expect: GUARD })).toThrow(/environment lights only/);
    expect(undo.begun).toBe(0);
  });

  it("refuses a text, shape, null, adjustment, model_3d or parametric_mesh layer as the source before the undo group", () => {
    const { comp, A, undo, plane } = layerScene();
    plane("HDRI");
    const kinds: Array<[string, string]> = [["TextLayer", "text"], ["ShapeLayer", "shape"]];
    for (const [reflect, kind] of kinds) {
      const l = new FakeLayer(comp, "Src " + kind, reflect);
      comp.stack.unshift(l);
      expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Src " + kind }, expect: GUARD })).toThrow(new RegExp("is a " + kind + " layer"));
    }
    const nul = comp.layers.addNull(10) as FakeLayer;
    nul.name = "Src null";
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Src null" }, expect: GUARD })).toThrow(/is a null layer/);
    const adj = plane("Src adjustment");
    adj.adjustmentLayer = true;
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Src adjustment" }, expect: GUARD })).toThrow(/is an adjustment layer/);
    const more: Array<[string, string]> = [["ThreeDModelLayer", "model_3d"], ["ParametricMeshLayer", "parametric_mesh"]];
    for (const [reflect, kind] of more) {
      comp.stack.unshift(new FakeLayer(comp, "Src " + kind, reflect));
      expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Src " + kind }, expect: GUARD })).toThrow(new RegExp("is a " + kind + " layer"));
    }
    expect(undo.begun).toBe(0);
  });

  it("takes only HDR or EXR footage before AE 25.2", () => {
    const { comp, A, undo, plane } = layerScene({ version: "25.1.0" });
    plane("Plain");
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "environment", light_source: { name: "Plain" }, expect: GUARD })).toThrow(/before 25\.2/);
    expect(undo.begun).toBe(0);
    const modern = layerScene({ version: "25.2.0" });
    modern.plane("Plain");
    expect(() => modern.A.createLayer({ comp_id: modern.comp.id, type: "light", light_type: "environment", light_source: { name: "Plain" }, expect: GUARD })).not.toThrow();
  });
});

describe("layers.jsx createLayer: light options", () => {
  it("sets the options of a spot light and reads them back", () => {
    const { comp, A } = layerScene();
    const r = A.createLayer({
      comp_id: comp.id,
      type: "light",
      light_type: "spot",
      light_options: { intensity: 150, color: [1, 0.5, 0.25], cone_angle: 45, cone_feather: 20, casts_shadows: true, shadow_darkness: 60, shadow_diffusion: 12 },
      expect: GUARD,
    });
    expect(r.light_options_applied).toEqual(["intensity", "color", "cone_angle", "cone_feather", "casts_shadows", "shadow_darkness", "shadow_diffusion"]);
    const l = comp.layer(1) as FakeLayer;
    expect(optionOf(l, "ADBE Light Intensity")).toBe(150);
    expect(optionOf(l, "ADBE Light Color")).toEqual([1, 0.5, 0.25, 1]);
    expect(optionOf(l, "ADBE Casts Shadows")).toBe(1);
    expect(stackOfComp(A, comp).layers[0].lightOptions).toEqual({
      intensity: 150,
      color: [1, 0.5, 0.25],
      cone_angle: 45,
      cone_feather: 20,
      casts_shadows: true,
      shadow_darkness: 60,
      shadow_diffusion: 12,
    });
  });

  it("refuses cone options on a point light and shadow options on an ambient light before the undo group", () => {
    const { comp, A, undo } = layerScene();
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "point", light_options: { cone_angle: 30 }, expect: GUARD })).toThrow(/spot lights only/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_type: "ambient", light_options: { casts_shadows: true }, expect: GUARD })).toThrow(/spot, point, parallel and environment/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_options: { falloff: 1 }, expect: GUARD })).toThrow(/Unknown light option/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_options: { color: [2, 0, 0] }, expect: GUARD })).toThrow(/0\.\.1/);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(0);
  });

  it("makes a point light when options are given without a type, whatever type AE would pick", () => {
    const { comp, A } = layerScene();
    const orig = comp.layers.addLight;
    // AE keeps the last-used light settings, so a new light can start as a spot light.
    comp.layers.addLight = (name: string, c: number[]) => {
      const l = orig(name, c) as FakeLayer;
      l.lightType = LightType.SPOT;
      return l;
    };
    A.createLayer({ comp_id: comp.id, type: "light", light_options: { intensity: 80 }, expect: GUARD });
    expect((comp.layer(1) as FakeLayer).lightType).toBe(LightType.POINT);
  });

  it("skips an option the light lacks and says so", () => {
    const { comp, A } = layerScene({ noShadowDiffusion: true });
    const r = A.createLayer({ comp_id: comp.id, type: "light", light_type: "point", light_options: { casts_shadows: true, shadow_diffusion: 5 }, expect: GUARD });
    expect(r.light_options_applied).toEqual(["casts_shadows"]);
    expect(r.light_options_skipped).toEqual(["shadow_diffusion"]);
    expect(r.warnings.join(" ")).toMatch(/shadow_diffusion/);
  });

  it("takes the whole layer back when an option is out of AE's range", () => {
    const { comp, A, undo } = layerScene({ intensityMax: 100 });
    expect(() => A.createLayer({ comp_id: comp.id, type: "light", light_options: { intensity: 500 }, expect: GUARD })).toThrow(/above AE's maximum/);
    expect(comp.numLayers).toBe(0);
    expect(undo).toEqual({ begun: 1, ended: 1 });
  });
});

describe("layers.jsx createLayer: parametric meshes", () => {
  it("builds a cube with options and a bevel, reassigning the option objects whole", () => {
    const { comp, A, undo } = layerScene();
    const r = A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "cube", mesh_options: { width: 300, depth: 40 }, bevel_options: { radius: 6, sides: 3 }, expect: GUARD });
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(r).toMatchObject({ kind: "mesh", mesh_type: "cube", name: "Cube" });
    const entry = stackOfComp(A, comp).layers[0];
    expect(entry.kind).toBe("parametric_mesh");
    expect(entry.mesh).toMatchObject({ type: "cube", options: { width: 300, height: 100, depth: 40 }, bevel: { radius: 6, sides: 3 } });
  });

  it("builds a sphere that is named and made 3D without throwing", () => {
    const { comp, A } = layerScene();
    A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "sphere", name: "Ball", mesh_options: { radius: 120 }, three_d: true, expect: GUARD });
    const entry = stackOfComp(A, comp).layers[0];
    expect(entry).toMatchObject({ name: "Ball", kind: "parametric_mesh", threeD: true });
    expect(entry.mesh?.options.radius).toBe(120);
  });

  it("refuses a bevel on a sphere, an unknown field, a wrong value type and a missing type before the undo group", () => {
    const { comp, A, undo } = layerScene();
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "sphere", bevel_options: { radius: 2 }, expect: GUARD })).toThrow(/no bevel options/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "plane", bevel_options: { radius: 2 }, expect: GUARD })).toThrow(/no bevel options/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "cube", mesh_options: { radius: 2 }, expect: GUARD })).toThrow(/no field "radius" for a cube/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "cylinder", mesh_options: { topCap: 1 }, expect: GUARD })).toThrow(/true or false/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "cube", mesh_options: { width: "wide" }, expect: GUARD })).toThrow(/must be a number/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", expect: GUARD })).toThrow(/mesh_type/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "shape", mesh_type: "cube", expect: GUARD })).toThrow(/mesh layers only/);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(0);
  });

  it("refuses on an AE without addParametricMesh, naming the version", () => {
    const { comp, A, undo } = layerScene({ noMesh: true });
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "cube", expect: GUARD })).toThrow(/26\.3/);
    expect(undo.begun).toBe(0);
  });

  it("refuses when the ParametricMeshType enum is missing", () => {
    const { comp, A, undo, G } = layerScene();
    G.ParametricMeshType = undefined;
    expect(() => A.createLayer({ comp_id: comp.id, type: "mesh", mesh_type: "cube", expect: GUARD })).toThrow(/ParametricMeshType\.CUBE is missing/);
    expect(undo.begun).toBe(0);
  });
});

describe("layers.jsx createLayer: vertical text and fonts", () => {
  it("makes vertical point and box text", () => {
    const { comp, A } = layerScene();
    A.createLayer({ comp_id: comp.id, type: "text", text: "縦", orientation: "vertical", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "text", text: "箱", orientation: "vertical", box_size: [200, 400], expect: GUARD });
    expect((comp.layer(1) as any).vertical).toBe(true);
    expect((comp.layer(2) as any).vertical).toBe(true);
    expect((comp.layer(1) as FakeLayer).rect.width).toBe(200);
  });

  it("refuses vertical text on an AE without it, before the undo group", () => {
    const { comp, A, undo } = layerScene({ noVertical: true });
    expect(() => A.createLayer({ comp_id: comp.id, type: "text", text: "x", orientation: "vertical", expect: GUARD })).toThrow(/24\.2/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "text", text: "x", orientation: "vertical", box_size: [10, 10], expect: GUARD })).toThrow(/24\.2/);
    expect(undo.begun).toBe(0);
  });

  it("warns when two or more installed fonts share the PostScript name", () => {
    const one = layerScene();
    expect(one.A.createLayer({ comp_id: one.comp.id, type: "text", text: "a", font: "ArialMT", expect: GUARD }).warnings.join(" ")).not.toMatch(/share this name/);
    const two = layerScene({ fontCopies: 2 });
    expect(two.A.createLayer({ comp_id: two.comp.id, type: "text", text: "a", font: "ArialMT", expect: GUARD }).warnings.join(" ")).toMatch(/2 installed fonts share this name/);
    const three = layerScene({ fontCopies: 3 });
    expect(three.A.createLayer({ comp_id: three.comp.id, type: "text", text: "a", font: "ArialMT", expect: GUARD }).warnings.join(" ")).toMatch(/3 installed fonts share this name/);
  });

  it("sets a resolved font by PostScript name or family and style, and reads it back", () => {
    const { comp, A } = layerScene();
    const r = A.createLayer({ comp_id: comp.id, type: "text", text: "Hi", font: { family: "Arial", style: "Bold" }, expect: GUARD });
    expect(r.font).toMatchObject({ postscript: "Arial-BoldMT", family: "Arial", style: "Bold" });
    const entry = stackOfComp(A, comp).layers[0];
    expect(entry.font).toBe("Arial-BoldMT");
    A.createLayer({ comp_id: comp.id, type: "text", text: "Yo", font: "ArialMT", expect: GUARD });
    expect(stackOfComp(A, comp).layers[0].font).toBe("ArialMT");
  });

  it("refuses an unknown or substituted font with near matches, before the undo group", () => {
    const { comp, A, undo } = layerScene();
    expect(() => A.createLayer({ comp_id: comp.id, type: "text", text: "x", font: "Arial-Black", expect: GUARD })).toThrow(/No installed font matches/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "text", text: "x", font: "GhostFont", expect: GUARD })).toThrow(/substitute/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "text", text: "x", font: { family: "Arial" }, expect: GUARD })).toThrow(/PostScript name or \{family, style\}/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "solid", font: "ArialMT", expect: GUARD })).toThrow(/text layers only/);
    expect(undo.begun).toBe(0);
    expect(comp.numLayers).toBe(0);
  });

  it("sets a PostScript name unchecked when this AE has no app.fonts, and refuses family and style", () => {
    const { comp, A } = layerScene({ noFonts: true });
    const r = A.createLayer({ comp_id: comp.id, type: "text", text: "x", font: "ArialMT", expect: GUARD });
    expect(r.warnings.join(" ")).toMatch(/not checked|app\.fonts/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "text", text: "x", font: { family: "Arial", style: "Bold" }, expect: GUARD })).toThrow(/PostScript name/);
  });

  it("leaves a plain text layer's result as before, with an empty warnings list", () => {
    const { comp, A } = layerScene();
    const r = A.createLayer({ comp_id: comp.id, type: "text", text: "Plain", expect: GUARD });
    expect(r).toMatchObject({ kind: "text", orientation: "horizontal" });
    expect(r.warnings).toEqual([]);
    expect(r.font).toBeUndefined();
  });
});

// ---------- layer kinds ----------

/** Adds a 3D model layer and a mesh layer, the ways AE names their classes. */
function kindsScene(files: string[]) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1920, 1080, 10);
  const model = new FakeLayer(comp, "robot.glb", "ThreeDModelLayer");
  model.threeDLayer = true;
  const mesh = new FakeLayer(comp, "Cube", "ParametricMeshLayer");
  mesh.threeDLayer = true;
  comp.stack.unshift(model, mesh);
  const host = loadHost(project, files);
  return { project, comp, ...host };
}

describe("model_3d / parametric_mesh kinds", () => {
  it("layers.jsx reports both kinds, by class name and by typeof-guarded instanceof", () => {
    const { comp, A } = kindsScene(["layers.jsx"]);
    expect(stackOfComp(A, comp).layers.map((l) => l.kind)).toEqual(["model_3d", "parametric_mesh"]);
    // With no usable reflect name, the typeof-guarded instanceof check still finds a model layer.
    const { comp: c2, A: A2, G } = kindsScene(["layers.jsx"]);
    class ThreeDModelLayer {
      static [Symbol.hasInstance](x: { name?: string }) {
        return x.name === "robot.glb";
      }
    }
    for (const l of c2.stack) (l as any).reflect = undefined;
    G.ThreeDModelLayer = ThreeDModelLayer;
    expect(stackOfComp(A2, c2).layers.map((l) => l.kind)).toEqual(["model_3d", ""]);
  });

  it("camera.jsx reads them as 3D layers of those kinds", () => {
    const { comp, A } = kindsScene(["camera.jsx"]);
    const res = plain(A.cameraSceneRead({ comp_id: comp.id, time: 0 })) as SceneRead;
    expect(res.layers.map((l) => [l.name, l.kind, l.three_d])).toEqual([
      ["robot.glb", "model_3d", true],
      ["Cube", "parametric_mesh", true],
    ]);
  });

  const hasKinds = (res: unknown) => {
    const text = JSON.stringify(res);
    return text.includes("model_3d") && text.includes("parametric_mesh");
  };

  it("ae_describe_comp's host read reports them as roles", () => {
    const { comp, A } = kindsScene(["describe.jsx"]);
    expect(hasKinds(plain(A.describeRead({ comp_id: comp.id })))).toBe(true);
  });

  it("ae_annotate_frame's host read reports them as kinds", () => {
    const { comp, A } = kindsScene(["annotate.jsx"]);
    expect(hasKinds(plain(A.annotateRead({ comp_id: comp.id, time: 0 })))).toBe(true);
  });

  it("ae_taste_baseline's host read reports them as kinds", () => {
    const { comp, A } = kindsScene(["learntaste.jsx"]);
    expect(hasKinds(plain(A.learntasteRead({ comp_id: comp.id })))).toBe(true);
  });

  it("ae_loudness_check's host read reports them as kinds", () => {
    const { comp, A } = kindsScene(["loudness.jsx"]);
    // Loudness lists layers that carry sound; give both so the kind shows.
    for (const l of comp.stack) (l as any).hasAudio = true;
    expect(hasKinds(plain(A.loudnessRead({ comp_id: comp.id })))).toBe(true);
  });

  it("ae_explain_layer reports the kind of a model layer", () => {
    const { comp, A } = kindsScene(["explain.jsx"]);
    const res = plain(A.explainLayer({ comp_id: comp.id, layer: { name: "robot.glb" } }));
    expect(JSON.stringify(res)).toContain("model_3d");
  });
});

// ---------- camera.jsx under node:vm ----------

const AutoOrientType = { ALONG_PATH: 1, CAMERA_OR_POINT_OF_INTEREST: 2, CHARACTERS_TOWARD_CAMERA: 3, NO_AUTO_ORIENT: 4 };

interface CamOpts {
  extraOptions?: Array<[string, string, number]>;
  lateFocusKeys?: boolean;
}

function cameraScene(o: CamOpts = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1920, 1080, 10);
  const cam = new FakeLayer(comp, "Camera 1", "CameraLayer");
  const options: Array<FakeProperty | FakeGroup> = [
    new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, 2666.667),
    new FakeProperty("Depth of Field", "ADBE Camera Depth of Field", PropertyValueType.OneD, 0),
    new FakeProperty("Focus Distance", "ADBE Camera Focus Distance", PropertyValueType.OneD, 1000),
    new FakeProperty("Aperture", "ADBE Camera Aperture", PropertyValueType.OneD, 0),
    new FakeProperty("Blur Level", "ADBE Camera Blur Level", PropertyValueType.OneD, 100),
  ];
  for (const [name, match, value] of o.extraOptions ?? []) options.push(new FakeProperty(name, match, PropertyValueType.OneD, value));
  const group = new FakeGroup("Camera Options", "ADBE Camera Options Group", options);
  group.parentProperty = cam.group;
  cam.group.props.push(group);
  const transform = cam.group.property("ADBE Transform Group") as FakeGroup;
  const poi = new FakeProperty("Point of Interest", "ADBE Point of Interest", PropertyValueType.ThreeD_SPATIAL, [960, 540, 0], true);
  poi.parentProperty = transform;
  transform.props.push(poi);
  (cam as any).autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
  comp.stack.unshift(cam);
  const { A, undo, G } = loadHost(project, ["camera.jsx"]);
  G.AutoOrientType = AutoOrientType;
  const plane = (name: string) => comp.layers.addSolid([1, 1, 1], name, 400, 300, 1, 10) as FakeLayer;
  const opt = (match: string) => (group.property(match) as FakeProperty);
  return { project, comp, cam, A, undo, plane, opt };
}

describe("camera.jsx cameraRig: retune", () => {
  it("sets a new lens without adding a layer", () => {
    const { comp, cam, A, undo, opt } = cameraScene();
    const r = plain(A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, lens: { focal_length: 35 }, expect: GUARD }));
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(comp.numLayers).toBe(1);
    expect(opt("ADBE Camera Zoom").value).toBeCloseTo(1866.667, 2);
    expect(r).toMatchObject({ retune: true, camera: { id: cam.id }, controller: null });
    expect(r.changes).toEqual([{ key: "zoom", value: expect.closeTo(1866.667, 2), keyed: false, replaced_key: false }]);
  });

  it("returns no_op and opens no undo group when everything is already as asked", () => {
    const { comp, A, undo } = cameraScene();
    const r = plain(A.cameraRig({ comp_id: comp.id, camera: { index: 1 }, lens: { zoom: 2666.667 }, depth_of_field: false, nodes: "two", expect: GUARD }));
    expect(r.no_op).toBe(true);
    expect(r.changes).toEqual([]);
    expect(undo.begun).toBe(0);
  });

  it("turns depth of field on with a focus layer expression, aperture and blur, then a fixed distance replaces the expression", () => {
    const { comp, A, plane, opt } = cameraScene();
    plane("Hero");
    const r = plain(A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, focus: { layer: { name: "Hero" }, aperture: 25, blur_level: 150 }, expect: GUARD }));
    expect(r.changes.map((c: any) => c.key)).toEqual(["depth_of_field", "focus_expression", "aperture", "blur_level"]);
    expect(opt("ADBE Camera Depth of Field").value).toBe(1);
    expect(opt("ADBE Camera Focus Distance").expression).toBe('var t = thisComp.layer("Hero"); fromWorld(t.toWorld(t.anchorPoint))[2]');
    expect(opt("ADBE Camera Aperture").value).toBe(25);
    const r2 = plain(A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, focus: { distance: 640 }, expect: GUARD }));
    expect(r2.warnings.join(" ")).toMatch(/expression is replaced/);
    expect(opt("ADBE Camera Focus Distance").expression).toBe("");
    expect(opt("ADBE Camera Focus Distance").value).toBe(640);
  });

  it("turns depth of field off, and switches between one and two nodes", () => {
    const { comp, cam, A, opt } = cameraScene();
    opt("ADBE Camera Depth of Field").setValue(1);
    A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, depth_of_field: false, nodes: "one", expect: GUARD });
    expect(opt("ADBE Camera Depth of Field").value).toBe(0);
    expect((cam as any).autoOrient).toBe(AutoOrientType.NO_AUTO_ORIENT);
    A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, nodes: "two", expect: GUARD });
    expect((cam as any).autoOrient).toBe(AutoOrientType.CAMERA_OR_POINT_OF_INTEREST);
  });

  it("refuses a keyframed Zoom unless at_time keys the value there", () => {
    const { comp, A, undo, opt } = cameraScene();
    const zoom = opt("ADBE Camera Zoom");
    zoom.setValueAtTime(0, 2666.667);
    zoom.setValueAtTime(4, 3000);
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 1 }, lens: { focal_length: 35 }, expect: GUARD })).toThrow(/keyframed/);
    expect(undo.begun).toBe(0);
    const r = plain(A.cameraRig({ comp_id: comp.id, camera: { index: 1 }, lens: { focal_length: 35 }, at_time: 2, expect: GUARD }));
    expect(zoom.numKeys).toBe(3);
    expect(r.changes[0]).toMatchObject({ key: "zoom", keyed: true, replaced_key: false });
    expect(r.keyed_at).toBe(2);
    // A key already at that time is replaced, not added.
    const r2 = plain(A.cameraRig({ comp_id: comp.id, camera: { index: 1 }, lens: { zoom: 1000 }, at_time: 2, expect: GUARD }));
    expect(zoom.numKeys).toBe(3);
    expect(r2.changes[0]).toMatchObject({ keyed: true, replaced_key: true });
  });

  it("refuses an expression-driven Zoom, a keyframed focus layer target and values outside AE's limits", () => {
    const { comp, A, undo, opt, plane } = cameraScene();
    plane("Hero");
    opt("ADBE Camera Zoom").expression = "1000";
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, lens: { zoom: 900 }, expect: GUARD })).toThrow(/expression/);
    opt("ADBE Camera Zoom").expression = "";
    Object.assign(opt("ADBE Camera Aperture"), { hasMax: true, maxValue: 100 });
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, focus: { aperture: 500 }, expect: GUARD })).toThrow(/above AE's maximum/);
    opt("ADBE Camera Focus Distance").setValueAtTime(0, 1);
    opt("ADBE Camera Focus Distance").setValueAtTime(1, 2);
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, focus: { layer: { name: "Hero" } }, expect: GUARD })).toThrow(/keyframed/);
    // Keyed and expression-driven together: a fixed distance cannot replace the expression, so it is refused.
    opt("ADBE Camera Focus Distance").expression = "100";
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, focus: { distance: 640 }, at_time: 0.5, expect: GUARD })).toThrow(/keyframed and driven by an expression/);
    expect(undo.begun).toBe(0);
  });

  it("refuses a layer that is not a camera, a locked camera and a focus target that shares a name", () => {
    const { comp, cam, A, undo, plane } = cameraScene();
    plane("Hero");
    plane("Hero");
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 2 }, lens: { zoom: 900 }, expect: GUARD })).toThrow(/not a camera layer/);
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, focus: { layer: { index: 2 } }, expect: GUARD })).toThrow(/rename the focus target/);
    cam.locked = true;
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, lens: { zoom: 900 }, expect: GUARD })).toThrow(/locked/);
    cam.locked = false;
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, preset: "push_in", lens: { zoom: 900 }, expect: GUARD })).toThrow(/when creating a camera/);
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { name: "Camera 1" }, expect: GUARD })).toThrow(/at least one of/);
    expect(() => A.cameraRig({ comp_id: comp.id, lens: { zoom: 900 }, at_time: 1, expect: GUARD })).toThrow(/retune/);
    expect(undo.begun).toBe(0);
  });

  it("puts everything back when a later change throws", () => {
    const { comp, A, undo, opt } = cameraScene();
    const aperture = opt("ADBE Camera Aperture");
    aperture.setValue = () => {
      throw new Error("AE refused");
    };
    expect(() => A.cameraRig({ comp_id: comp.id, camera: { index: 1 }, lens: { zoom: 900 }, focus: { distance: 500, aperture: 10 }, expect: GUARD })).toThrow(/AE refused/);
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(opt("ADBE Camera Zoom").value).toBe(2666.667);
    expect(opt("ADBE Camera Depth of Field").value).toBe(0);
    expect(opt("ADBE Camera Focus Distance").value).toBe(1000);
  });

  it("probes the 26.3 focus options: sets them when found, warns when the camera has none", () => {
    const withOpts = cameraScene({
      extraOptions: [
        ["Focus Area Width", "ADBE Camera Focus Area Width", 10],
        ["Near/Far Blur Multiplier", "ADBE Camera Near Far Blur Multiplier", 1],
      ],
    });
    const r = plain(
      withOpts.A.cameraRig({ comp_id: withOpts.comp.id, camera: { index: 1 }, focus: { focus_area_width: 40, near_far_blur_multiplier: 2.5 }, expect: GUARD })
    );
    expect(withOpts.opt("ADBE Camera Focus Area Width").value).toBe(40);
    expect(withOpts.opt("ADBE Camera Near Far Blur Multiplier").value).toBe(2.5);
    expect(r.probe).toEqual({ focus_area_width: "ADBE Camera Focus Area Width", near_far_blur_multiplier: "ADBE Camera Near Far Blur Multiplier" });
    // Unknown match names are found by their display names.
    const odd = cameraScene({ extraOptions: [["Focus Area Width", "ADBE Weird Name", 10]] });
    odd.A.cameraRig({ comp_id: odd.comp.id, camera: { index: 1 }, focus: { focus_area_width: 33 }, expect: GUARD });
    expect(odd.opt("ADBE Weird Name").value).toBe(33);
    const none = cameraScene();
    const r3 = plain(none.A.cameraRig({ comp_id: none.comp.id, camera: { index: 1 }, focus: { focus_area_width: 40, aperture: 5 }, expect: GUARD }));
    expect(r3.warnings.join(" ")).toMatch(/focus_area_width property/);
    expect(r3.changes.map((c: any) => c.key)).toEqual(["depth_of_field", "aperture"]);
  });

  it("reads the retuned camera's key counts and 26.3 options back for the receipt", () => {
    const { comp, A } = cameraScene({ extraOptions: [["Focus Area Width", "ADBE Camera Focus Area Width", 12]] });
    const res = plain(A.cameraRead({ comp_id: comp.id, ids: [] })) as CameraReadBack;
    expect(res.cameras[0]).toMatchObject({ focus_area_width: 12, near_far_blur_multiplier: null, num_keys: { zoom: 0, focus_distance: 0, aperture: 0, blur_level: 0 } });
  });

  it("reads the stored values at the keyed time, and counts keys on the 26.3 options", () => {
    const { comp, A, opt } = cameraScene({ extraOptions: [["Focus Area Width", "ADBE Camera Focus Area Width", 12]] });
    opt("ADBE Camera Zoom").setValueAtTime(0, 2666.667);
    opt("ADBE Camera Zoom").setValueAtTime(4, 3000);
    opt("ADBE Camera Focus Area Width").setValueAtTime(1, 12);
    opt("ADBE Camera Focus Area Width").setValueAtTime(3, 20);
    const none = plain(A.cameraRead({ comp_id: comp.id, ids: [] })) as CameraReadBack;
    expect(none.cameras[0].values_at).toBeUndefined();
    const res = plain(A.cameraRead({ comp_id: comp.id, ids: [], at_time: 2 })) as CameraReadBack;
    expect(res.cameras[0].num_keys).toMatchObject({ zoom: 2, focus_area_width: 2, near_far_blur_multiplier: null });
    expect(res.cameras[0].values_at).toMatchObject({ time: 2, focus_area_width: 16, near_far_blur_multiplier: null });
    expect(res.cameras[0].values_at?.zoom).toBeCloseTo(2833.3335, 3);
  });

  it("still builds a new camera when camera is not given", () => {
    const { comp, A } = cameraScene();
    const before = comp.numLayers;
    comp.layers.addCamera = (name: string) => {
      const l = new FakeLayer(comp, name, "CameraLayer");
      const grp = new FakeGroup("Camera Options", "ADBE Camera Options Group", [new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, 1000)]);
      grp.parentProperty = l.group;
      l.group.props.push(grp);
      comp.stack.unshift(l);
      return l;
    };
    const r = plain(A.cameraRig({ comp_id: comp.id, name: "New", expect: GUARD }));
    expect(r.camera.name).toBe("New");
    expect(comp.numLayers).toBe(before + 1);
  });
});

describe("camera.jsx cameraSceneRead: lights", () => {
  it("adds each light's type, source, intensity, colour, cone and shadows", () => {
    const { comp, A, plane } = cameraScene();
    const hdri = plane("HDRI");
    const light = new FakeLayer(comp, "Env", "LightLayer");
    const p = hdrOptions();
    const g = new FakeGroup("Light Options", "ADBE Light Options Group", [p.intensity, p.color, p.coneAngle, p.coneFeather, p.shadows, p.darkness, p.diffusion]);
    g.parentProperty = light.group;
    light.group.props.push(g);
    p.intensity.setValue(80);
    p.shadows.setValue(1);
    (light as any).lightType = 4416;
    (light as any).lightSource = hdri;
    comp.stack.unshift(light);
    const sceneLight = plain(A.cameraSceneRead({ comp_id: comp.id, time: 0 }) as SceneRead).layers.find((l: SceneLayer) => l.name === "Env");
    expect(sceneLight?.kind).toBe("light");
    expect(sceneLight?.light).toMatchObject({
      source: { id: hdri.id, name: "HDRI" },
      intensity: 80,
      color: [1, 1, 1],
      casts_shadows: true,
      cone_angle: 90,
      cone_feather: 50,
      shadow_darkness: 100,
    });
  });

  it("reports a light without options as nulls instead of throwing", () => {
    const { comp, A } = cameraScene();
    comp.stack.unshift(new FakeLayer(comp, "Bare", "LightLayer"));
    const l = plain(A.cameraSceneRead({ comp_id: comp.id, time: 0 }) as SceneRead).layers.find((x: SceneLayer) => x.name === "Bare");
    expect(l?.light).toMatchObject({ source: null, intensity: null, color: null, casts_shadows: null });
  });
});
