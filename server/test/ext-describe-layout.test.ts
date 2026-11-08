/**
 * ae_describe_comp with layout: true: what a template holds (boxes, masks,
 * flags, source kinds, camera data, regions). Host code under node:vm against
 * test/support/fake-ae.ts; the tool against a fake bridge.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeDescribeCompSchema, describeTools } from "../src/tools/ext/describe.js";
import { FakeFootage, FakeGroup, FakeProject, FakeProperty, FileSource, MaskMode, PlaceholderSource, PropertyValueType, Shape, TrackMatteType, loadHost, type FakeComp, type FakeLayer } from "./support/fake-ae.js";

const AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214 };

/** The describe host with AE's AutoOrientType, which a camera's two-node test reads. */
function load(project: FakeProject) {
  const host = loadHost(project, ["describe.jsx"]);
  Object.assign(host.G, { AutoOrientType });
  return host;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = describeTools.find((t) => t.name === "ae_describe_comp")!;

function shape(vertices: number[][], tangent = false): Shape {
  const s = new Shape();
  s.vertices = vertices;
  s.inTangents = vertices.map(() => (tangent ? [10, 0] : [0, 0]));
  s.outTangents = vertices.map(() => (tangent ? [-10, 0] : [0, 0]));
  return s;
}

/** Puts a mask on a layer the way AE's parade does and returns it. */
function addMask(l: FakeLayer, name: string, verts: number[][], opts: { tangent?: boolean; mode?: number; inverted?: boolean } = {}) {
  const parade = l.property("ADBE Mask Parade") as any;
  const mask = parade.addProperty("ADBE Mask Atom");
  mask.name = name;
  mask.maskMode = opts.mode ?? MaskMode.ADD;
  mask.inverted = opts.inverted ?? false;
  (mask.property("ADBE Mask Shape") as any).setValue(shape(verts, opts.tangent));
  return mask;
}

function place(l: FakeLayer, pos: number[], rect: { width: number; height: number }, extra: { anchor?: number[]; scale?: number[]; rotation?: number } = {}) {
  l.rect = { left: 0, top: 0, width: rect.width, height: rect.height };
  l.transform("Position").setValue([pos[0], pos[1], 0]);
  l.transform("Anchor Point").setValue([...(extra.anchor ?? [0, 0]), 0]);
  if (extra.scale) l.transform("Scale").setValue([extra.scale[0], extra.scale[1], 100]);
  if (extra.rotation !== undefined) l.transform("Rotation").setValue(extra.rotation);
}

/** A template: two masked layers (one scaled and rotated), a guide layer, a placeholder layer, a camera, a parented and a 3D layer. */
function template() {
  const project = new FakeProject();
  const comp = project.addComp("Master", 1920, 1080, 4) as FakeComp;
  const solid = (name: string) => comp.layers.addSolid([0.1, 0.1, 0.1], name, 640, 360, 1) as FakeLayer;
  const screenA = solid("Screen A");
  place(screenA, [100, 50], { width: 640, height: 360 });
  addMask(screenA, "Left half", [[0, 0], [320, 0], [320, 360], [0, 360]]);
  addMask(screenA, "Curved", [[0, 0], [100, 0], [100, 100]], { tangent: true, mode: MaskMode.SUBTRACT, inverted: true });

  const rot = solid("Rotated");
  place(rot, [500, 200], { width: 200, height: 100 }, { scale: [50, 50], rotation: 90 });
  addMask(rot, "Mask 1", [[0, 0], [200, 0], [200, 100], [0, 100]]);

  const guide = solid("Floor guide");
  place(guide, [0, 700], { width: 1920, height: 300 });
  guide.guideLayer = true;

  const missing = project.addFootage("Missing plate", 800, 450, new PlaceholderSource());
  const ph = comp.layers.add(missing) as FakeLayer;
  place(ph, [1000, 100], { width: 800, height: 450 });

  const cam = comp.layers.addCamera("Camera 1", [960, 540]) as FakeLayer;
  const opts = new FakeGroup("Camera Options", "ADBE Camera Options Group", [new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, 1500)]);
  opts.parentProperty = cam.group;
  cam.group.props.push(opts);
  // A camera's point of interest is its Anchor Point stream; two nodes is the layer's auto-orient.
  cam.transform("Anchor Point").setValue([960, 540, 0]);
  (cam as any).autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
  const parented = solid("Parented");
  parented.parent = screenA;
  const threeD = solid("Three D");
  threeD.threeDLayer = true;
  return { project, comp, screenA, rot, guide, ph, cam, parented, threeD };
}

describe("describe.jsx with layout: true", () => {
  it("returns boxes, masks, flags, source kinds, camera data and regions", () => {
    const { project, comp } = template();
    const { A } = load(project);
    const r = A.describeRead({ comp_id: comp.id, layout: true });
    const row = (n: string) => r.layers.find((l: any) => l.name === n);

    expect(row("Screen A").layout.rect).toEqual([100, 50, 640, 360]);
    expect(row("Screen A").layout.flags).toMatchObject({ enabled: true, guide: false, shy: false, locked: false, three_d: false, null_layer: false });
    const masks = row("Screen A").layout.masks;
    expect(masks).toHaveLength(2);
    expect(masks[0]).toMatchObject({ name: "Left half", mode: "add", inverted: false, vertices: 4, rect: [100, 50, 320, 360] });
    expect(masks[0].rect_approx).toBeUndefined();
    expect(masks[1]).toMatchObject({ name: "Curved", mode: "subtract", inverted: true, rect_approx: true });

    // Scaled 50% and rotated 90 degrees: the box is worked out through the full layer matrix.
    expect(row("Rotated").layout.rect).toEqual([450, 200, 50, 100]);
    expect(row("Rotated").layout.masks[0].rect).toEqual([450, 200, 50, 100]);

    expect(row("Floor guide").layout.flags.guide).toBe(true);
    expect(row("Missing plate").layout.source).toMatchObject({ kind: "placeholder", width: 800, height: 450 });
    expect(row("Screen A").layout.source).toMatchObject({ kind: "solid", width: 640, height: 360 });

    expect(row("Camera 1").layout.rect).toBeNull();
    expect(row("Camera 1").layout.rect_reason).toBe("camera");
    expect(row("Camera 1").layout.camera).toMatchObject({ two_node: true, zoom: 1500, point_of_interest: [960, 540, 0], keyed_properties: [] });
    expect(row("Camera 1").layout.camera.position).toHaveLength(3);
    expect(row("Parented").layout.rect_reason).toBe("parented");
    expect(row("Three D").layout.rect_reason).toBe("3d");
    expect(r.layout).toEqual({ time: 0, rects_unavailable: 3, masks_truncated: false });

    expect(r.regions.map((g: any) => [g.name, g.from, g.rect])).toEqual([
      ["Missing plate", "placeholder", [1000, 100, 800, 450]],
      ["Floor guide", "guide_layer", [0, 700, 1920, 300]],
      ["Rotated / Mask 1", "mask", [450, 200, 50, 100]],
      ["Left half", "mask", [100, 50, 320, 360]],
      ["Curved", "mask", [100, 50, 100, 100]],
    ]);
    expect(r.regions[3]).toMatchObject({ layer: { name: "Screen A" }, mask: "Left half" });
    expect(r.regions[4].rect_approx).toBe(true);
    expect(r.regions_truncated).toBe(false);
  });

  it("changes nothing in the project: time, layers, positions and masks stay, no undo group", () => {
    const { project, comp } = template();
    comp.time = 1.25;
    const { A, undo, G } = load(project);
    const snap = () =>
      JSON.stringify({
        time: comp.time,
        items: project.numItems,
        layers: comp.stack.map((l) => [l.id, l.name, l.index, l.enabled, l.transform("Position").value, l.transform("Scale").value, (l.property("ADBE Mask Parade") as any).numProperties]),
      });
    const before = snap();
    const keys = Object.keys(G);
    A.describeRead({ comp_id: comp.id, layout: true, layout_time: 2 });
    expect(snap()).toBe(before);
    expect(undo).toEqual({ begun: 0, ended: 0 });
    expect(Object.keys(G)).toEqual(keys);
  });

  it("without layout the output is exactly what it was, and with layout it only adds fields", () => {
    const { project, comp } = template();
    const { A } = load(project);
    const plain = A.describeRead({ comp_id: comp.id });
    expect(JSON.stringify(A.describeRead({ comp_id: comp.id, layout: false }))).toBe(JSON.stringify(plain));
    expect("layout" in plain).toBe(false);
    expect("regions" in plain).toBe(false);
    expect(plain.layers.some((l: any) => "layout" in l)).toBe(false);
    const withLayout = A.describeRead({ comp_id: comp.id, layout: true });
    const stripped = JSON.parse(JSON.stringify(withLayout));
    delete stripped.layout;
    delete stripped.regions;
    delete stripped.regions_truncated;
    for (const l of stripped.layers) delete l.layout;
    expect(stripped).toEqual(JSON.parse(JSON.stringify(plain)));
  });

  it("reads at the time asked for, and says when masks or regions were cut", () => {
    const { project, comp, screenA } = template();
    for (let i = 0; i < 4; i++) addMask(screenA, `Extra ${i}`, [[0, 0], [10, 0], [10, 10]]);
    const key = (screenA.transform("Position") as any);
    key.setValueAtTime(0, [100, 50, 0]);
    key.setValueAtTime(2, [300, 50, 0]);
    const { A } = load(project);
    const r = A.describeRead({ comp_id: comp.id, layout: true, layout_time: 2, max_masks_per_layer: 3 });
    const a = r.layers.find((l: any) => l.name === "Screen A").layout;
    expect(a.rect).toEqual([300, 50, 640, 360]);
    expect(a.masks).toHaveLength(3);
    expect(a.masks_total).toBe(6);
    expect(r.layout).toMatchObject({ time: 2, masks_truncated: true });

    const big = new FakeProject();
    const bc = big.addComp("Big", 1920, 1080, 2) as FakeComp;
    for (let i = 0; i < 130; i++) {
      const g = bc.layers.addSolid([0, 0, 0], `G${i}`, 10, 10, 1) as FakeLayer;
      place(g, [i, i], { width: 10, height: 10 });
      g.guideLayer = true;
    }
    const host2 = load(big);
    const r2 = host2.A.describeRead({ comp_id: bc.id, layout: true, max_layers: 200 });
    expect(r2.regions).toHaveLength(100);
    expect(r2.regions_truncated).toBe(true);
  });
});

describe("ae_describe_comp layout argument", () => {
  function bridge(raw: unknown) {
    const calls: Array<{ fn: string; script: string }> = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-describe-layout-"));
    tmpDirs.push(dir);
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        calls.push({ fn: script.slice("__chromaAe.".length, script.indexOf("(")), script });
        return { ok: true, result: raw, durationMs: 1 };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    return { ctx, calls };
  }

  it("takes layout, layout_time and max_masks_per_layer and stays read-only", () => {
    const ok = AeDescribeCompSchema.safeParse({ comp_id: 1, layout: true, layout_time: 1.5, max_masks_per_layer: 5 });
    expect(ok.success).toBe(true);
    expect(AeDescribeCompSchema.safeParse({ comp_id: 1, max_masks_per_layer: 51 }).success).toBe(false);
    expect(tool.description).toMatch(/layout: true/);
  });

  it("passes the arguments to the host, implies the layer rows, and merges the layout fields into them", async () => {
    const { project, comp } = template();
    const { A } = load(project);
    const raw = JSON.parse(JSON.stringify(A.describeRead({ comp_id: comp.id, layout: true })));
    const { ctx, calls } = bridge(raw);
    const out: any = await tool.handler(AeDescribeCompSchema.parse({ comp_id: comp.id, layout: true, layout_time: 1, max_masks_per_layer: 7 }), ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toContain('"layout":true');
    expect(calls[0].script).toContain('"layout_time":1');
    expect(calls[0].script).toContain('"max_masks_per_layer":7');
    const a = out.layers.find((l: any) => l.name === "Screen A");
    expect(a).toMatchObject({ rect: [100, 50, 640, 360], enabled: true, shy: false, guide: false, locked: false, solo: false, three_d: false, null_layer: false, adjustment: false, masks_total: 2 });
    expect(a.source).toMatchObject({ kind: "solid", width: 640, height: 360 });
    expect(a.masks[0].name).toBe("Left half");
    const cam = out.layers.find((l: any) => l.name === "Camera 1");
    expect(cam).toMatchObject({ rect: null, rect_reason: "camera" });
    expect(cam.camera).toMatchObject({ two_node: true, zoom: 1500 });
    expect(out.regions).toHaveLength(5);
    expect(out.layout.rects_unavailable).toBe(3);
  });

  it("puts the layout fields flat on each layer row: no nested `layout` key there, only at the top", async () => {
    const { project, comp } = template();
    const { A } = load(project);
    const raw = JSON.parse(JSON.stringify(A.describeRead({ comp_id: comp.id, layout: true })));
    const { ctx } = bridge(raw);
    // include_layers together with layout must keep every layout field.
    const out: any = await tool.handler(AeDescribeCompSchema.parse({ comp_id: comp.id, layout: true, include_layers: true }), ctx);
    expect(out.ok).toBe(true);
    expect(out.layout).toBeDefined();
    expect(Array.isArray(out.regions)).toBe(true);
    expect(out.layers.some((l: any) => l.layout !== undefined)).toBe(false);
    expect(out.layers.every((l: any) => "rect" in l && "masks_total" in l && "enabled" in l)).toBe(true);
  });

  it("is unchanged without layout: no layout fields, layer rows only on request", async () => {
    const { project, comp } = template();
    const { A } = load(project);
    const raw = JSON.parse(JSON.stringify(A.describeRead({ comp_id: comp.id })));
    const { ctx, calls } = bridge(raw);
    const out: any = await tool.handler(AeDescribeCompSchema.parse({ comp_id: comp.id }), ctx);
    expect(out.layers).toBeUndefined();
    expect("layout" in out).toBe(false);
    expect("regions" in out).toBe(false);
    expect(calls[0].script).not.toContain("layout");
    const rows: any = await tool.handler(AeDescribeCompSchema.parse({ comp_id: comp.id, include_layers: true }), ctx);
    expect(rows.layers[0].rect).toBeUndefined();
    expect(PropertyValueType.SHAPE).toBeDefined();
  });
});

// ---------- what each read depends on (one case per field, so a change to any of them is seen) ----------

describe("describe.jsx layout: field by field", () => {
  const solid = (comp: FakeComp, name: string, w = 100, h = 50) => comp.layers.addSolid([0.5, 0.5, 0.5], name, w, h, 1) as FakeLayer;
  const scene = () => {
    const project = new FakeProject();
    const comp = project.addComp("Tpl", 1920, 1080, 4) as FakeComp;
    return { project, comp };
  };
  const read = (project: FakeProject, comp: FakeComp, extra: object = {}) => {
    const out = clean(load(project).A.describeRead({ comp_id: comp.id, layout: true, ...extra }));
    return { out, row: (n: string) => out.layers.find((l: any) => l.name === n) };
  };
  const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  it("a text-like box with a left / top offset lands where the layer's matrix puts it", () => {
    const { project, comp } = scene();
    const t = solid(comp, "Text");
    t.rect = { left: -50, top: -20, width: 100, height: 40 };
    t.transform("Position").setValue([500, 300, 0]);
    t.transform("Anchor Point").setValue([0, 0, 0]);
    expect(read(project, comp).row("Text").layout.rect).toEqual([450, 280, 100, 40]);
  });

  it("the box is read at layout_time through sourceRectAtTime, not at time 0 or the comp time", () => {
    const { project, comp } = scene();
    const g = solid(comp, "Grows");
    g.rectAt = (t) => ({ left: 0, top: 0, width: 100 + t * 100, height: 50 });
    g.transform("Position").setValue([0, 0, 0]);
    comp.time = 1;
    expect(read(project, comp).row("Grows").layout.rect).toEqual([0, 0, 200, 50]);
    expect(read(project, comp, { layout_time: 2 }).row("Grows").layout.rect).toEqual([0, 0, 300, 50]);
    expect(read(project, comp, { layout_time: 0 }).row("Grows").layout.rect).toEqual([0, 0, 100, 50]);
  });

  it("a keyed mask path is read at layout_time and marked animated", () => {
    const { project, comp } = scene();
    const l = solid(comp, "Keyed", 640, 360);
    l.transform("Position").setValue([0, 0, 0]);
    const mask = addMask(l, "Move", [[0, 0], [10, 0], [10, 10]]);
    const prop = mask.property("ADBE Mask Shape") as any;
    prop.staticValue = shape([[0, 0], [10, 0], [10, 10]]);
    prop.setValueAtTime(0, shape([[0, 0], [10, 0], [10, 10]]));
    prop.setValueAtTime(2, shape([[100, 100], [200, 100], [200, 150]]));
    const first = read(project, comp, { layout_time: 0 }).row("Keyed").layout.masks[0];
    const later = read(project, comp, { layout_time: 2 }).row("Keyed").layout.masks[0];
    expect(first.rect).toEqual([0, 0, 10, 10]);
    expect(later.rect).toEqual([100, 100, 100, 50]);
    expect(later.animated).toBe(true);
  });

  it("an adjustment layer and a null say so in the flags", () => {
    const { project, comp } = scene();
    const a = solid(comp, "Adj");
    a.adjustmentLayer = true;
    const n = comp.layers.addNull() as FakeLayer;
    n.name = "Nul";
    n.nullLayer = true;
    const r = read(project, comp);
    expect(r.row("Adj").layout.flags).toMatchObject({ adjustment: true, null_layer: false });
    expect(r.row("Nul").layout.flags).toMatchObject({ adjustment: false, null_layer: true });
  });

  it("a layer used as a track matte gives no region for a default-named mask, but does for a named one", () => {
    const { project, comp } = scene();
    const matte = solid(comp, "Matte", 640, 360);
    matte.transform("Position").setValue([0, 0, 0]);
    addMask(matte, "Mask 1", [[0, 0], [100, 0], [100, 100]]);
    addMask(matte, "Hero window", [[10, 10], [60, 10], [60, 60]]);
    const user = solid(comp, "User");
    user.setTrackMatte!(matte, TrackMatteType.ALPHA);
    const r = read(project, comp);
    expect(r.row("Matte").is_matte).toBe(true);
    expect(r.out.regions.map((g: any) => g.name)).toEqual(["Hero window"]);
    // Without the matte, the default-named mask is a region too.
    const other = scene();
    const free = solid(other.comp, "Free", 640, 360);
    free.transform("Position").setValue([0, 0, 0]);
    addMask(free, "Mask 1", [[0, 0], [100, 0], [100, 100]]);
    expect(read(other.project, other.comp).out.regions.map((g: any) => g.name)).toEqual(["Free / Mask 1"]);
  });

  it("one layer that is both a guide and a placeholder gives one region, not two", () => {
    const { project, comp } = scene();
    const missing = project.addFootage("Gone", 300, 200, new PlaceholderSource());
    const l = comp.layers.add(missing) as FakeLayer;
    l.name = "Both";
    l.guideLayer = true;
    l.transform("Position").setValue([10, 20, 0]);
    l.transform("Anchor Point").setValue([0, 0, 0]);
    const r = read(project, comp);
    expect(r.out.regions).toHaveLength(1);
    expect(r.out.regions[0]).toMatchObject({ name: "Both", from: "guide_layer", rect: [10, 20, 300, 200] });
  });

  it("footage whose file is missing reads as kind missing, with its size", () => {
    const { project, comp } = scene();
    const src = new FileSource();
    const f = new FakeFootage("Lost.mov", 800, 450, src);
    f.project = project;
    f.parentFolder = project.rootFolder;
    f.footageMissing = true;
    project.all.push(f);
    const l = comp.layers.add(f) as FakeLayer;
    expect(read(project, comp).row(l.name).layout.source).toMatchObject({ kind: "missing", width: 800, height: 450 });
  });

  it("a camera with one node is not two-node, and zoom comes from the camera options", () => {
    const { project, comp } = scene();
    const cam = comp.layers.addCamera("Cam", [960, 540]) as FakeLayer;
    const opts = new FakeGroup("Camera Options", "ADBE Camera Options Group", [new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, 2222)]);
    opts.parentProperty = cam.group;
    cam.group.props.push(opts);
    (cam as any).autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    expect(read(project, comp).row("Cam").layout.camera).toMatchObject({ two_node: false, zoom: 2222 });
    (cam as any).autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    expect(read(project, comp).row("Cam").layout.camera.two_node).toBe(true);
    // Keyed zoom is reported as keyed.
    (cam.group.property("ADBE Camera Options Group") as any).property("ADBE Camera Zoom").setValueAtTime(0, 2222);
    expect(read(project, comp).row("Cam").layout.camera.keyed_properties).toContain("zoom");
  });

  it("a page holds at most 400 masks over all its layers, and says it was cut", () => {
    const { project, comp } = scene();
    for (let i = 0; i < 200; i++) {
      const l = solid(comp, `L${i}`, 50, 50);
      for (let m = 0; m < 20; m++) addMask(l, `M${m}`, [[0, 0], [10, 0], [10, 10]]);
    }
    const { out } = read(project, comp, { max_layers: 200 });
    const listed = out.layers.reduce((n: number, l: any) => n + l.layout.masks.length, 0);
    expect(listed).toBe(400);
    expect(out.layout.masks_truncated).toBe(true);
    expect(out.layers.every((l: any) => l.layout.masks_total === 20)).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(400_000);
  });
});
