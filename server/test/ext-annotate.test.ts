/**
 * ae_annotate_frame: the schema, the pure maths (matrices, boxes, camera
 * projection, view mapping, tags, stats), the drawing, the tool run against a
 * fake bridge, and panel/host/ext/annotate.jsx under node:vm against the fake
 * AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeAnnotateFrameSchema,
  annotateTools,
  buildIndex,
  cameraModel,
  chainMatrix,
  chooseLayers,
  colorFor,
  composePair,
  defaultCamera,
  drawAnnotations,
  effectiveGridSpacing,
  gridStats,
  layerBox,
  layerLocalMatrix,
  layerMap,
  makeView,
  mat4Identity,
  mat4Invert,
  mat4Mul,
  renderBase,
  tagText,
  toOutput,
  transformPoint,
  type DrawOptions,
  type HostLayer,
  type HostRead,
  type HostTransform,
} from "../src/tools/ext/annotate.js";
import { cropImage, drawText, regionStats, scaleNearest, textWidth } from "../src/tools/ext/png-utils.js";
import { FakeGroup, FakeProperty, FakeProject, loadHost, PropertyValueType } from "./support/fake-ae.js";

const tool = annotateTools.find((t) => t.name === "ae_annotate_frame")!;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------- builders for host data ----------

const T = (over: Partial<HostTransform> = {}): HostTransform => ({
  anchor: [0, 0, 0],
  position: [0, 0, 0],
  scale: [100, 100, 100],
  rotation_z: 0,
  orientation: [0, 0, 0],
  rotation_x: 0,
  rotation_y: 0,
  point_of_interest: null,
  ...over,
});

const HL = (index: number, over: Partial<HostLayer> = {}): HostLayer => ({
  index,
  id: 100 + index,
  name: `Layer ${index}`,
  kind: "solid",
  enabled: true,
  solo: false,
  selected: false,
  three_d: false,
  parent_id: null,
  in_point: 0,
  out_point: 4,
  visible: true,
  active_at_time: true,
  rect: { left: 0, top: 0, width: 100, height: 50 },
  skip_reason: null,
  transform: T(),
  ...over,
});

const READ = (layers: HostLayer[], over: Partial<HostRead> = {}, comp: Partial<HostRead["comp"]> = {}): HostRead => ({
  comp: { id: 1, name: "Main", width: 1000, height: 500, pixel_aspect: 1, fps: 25, duration: 4, resolution_factor: [1, 1], ...comp },
  time: 1,
  layers,
  total_layers: layers.length,
  truncated: false,
  active_camera_id: null,
  comp_active_camera_id: null,
  solo_active: false,
  ...over,
});

const box = (read: HostRead, index: number, include3d = true) => {
  const byId = layerMap(read.layers);
  const layer = read.layers.find((l) => l.index === index)!;
  return layerBox(layer, byId, cameraModel(read, byId), read.comp, include3d);
};

const near = (a: number[], b: number[], eps = 1e-6) => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
};

// ---------- schema ----------

describe("ae_annotate_frame schema", () => {
  it("fills the defaults and is not a mutating tool", () => {
    const a = AeAnnotateFrameSchema.parse({ comp_id: 3, time: 1.5 });
    expect(a).toMatchObject({
      layers: "visible",
      outlines: true,
      tags: true,
      anchors: true,
      safe_areas: true,
      action_safe: 0.1,
      title_safe: 0.2,
      include_extents: false,
      rulers: true,
      checkerboard: true,
      stats: true,
      stats_cols: 2,
      stats_rows: 2,
      max_size: 1600,
    });
    expect(a.time_b).toBeUndefined();
    expect(a.zoom).toBeUndefined();
    // A read tool: no expect guard in its inputs, and it says so.
    expect(Object.keys(AeAnnotateFrameSchema.shape)).not.toContain("expect");
    expect(tool.description).toContain("READ-ONLY");
  });

  it("rejects a negative time, a bad layer mode, an empty zoom and out-of-range limits", () => {
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: -1 }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, layers: "some" }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, zoom: { x: 0, y: 0, width: 0, height: 10 } }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, grid: 0 }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, stats_cols: 9 }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, max_size: 100 }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, action_safe: 0.9 }).success).toBe(false);
    expect(AeAnnotateFrameSchema.safeParse({ comp_id: 1, time: 0, zoom: { x: 5, y: 5, width: 50, height: 50 }, grid: 10, time_b: 2 }).success).toBe(true);
  });
});

// ---------- maths ----------

describe("matrices", () => {
  it("inverts a transform and returns null for a singular one", () => {
    const m = layerLocalMatrix(T({ anchor: [10, 20, 0], position: [300, 200, 0], scale: [50, 80, 100], rotation_z: 30 }), false);
    const inv = mat4Invert(m)!;
    near(mat4Mul(m, inv), mat4Identity(), 1e-9);
    expect(mat4Invert([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBeNull();
  });

  it("a 2D layer's matrix is position * rotation * scale * -anchor, rotating clockwise on screen", () => {
    const m = layerLocalMatrix(T({ anchor: [50, 25, 0], position: [200, 100, 0], rotation_z: 90 }), false);
    // The layer's (0, 0) corner is (-50, -25) from the anchor; 90 degrees clockwise puts it at (25, -50).
    near(transformPoint(m, [0, 0, 0]), [225, 50, 0]);
    near(transformPoint(m, [50, 25, 0]), [200, 100, 0]);
  });

  it("a 2D layer ignores z, orientation and X/Y rotation", () => {
    const flat = layerLocalMatrix(T({ position: [10, 20, 300], rotation_x: 40, rotation_y: 40, orientation: [10, 20, 30] }), false);
    near(transformPoint(flat, [0, 0, 0]), [10, 20, 0]);
  });

  it("composes a parent chain, root first", () => {
    const parent = HL(2, { transform: T({ position: [100, 100, 0], scale: [200, 200, 100] }) });
    const kid = HL(1, { parent_id: parent.id, transform: T({ position: [10, 5, 0] }) });
    const chain = chainMatrix(kid, layerMap([kid, parent]));
    // The child's (0,0) is at (10,5) in the parent, which is doubled and moved to (120,110).
    near(transformPoint(chain.matrix!, [0, 0, 0]), [120, 110, 0]);
    expect(chain.has3dAncestor).toBe(false);
  });

  it("reports a parent that was not read and an over-deep chain instead of guessing", () => {
    const kid = HL(1, { parent_id: 999 });
    expect(chainMatrix(kid, layerMap([kid])).reason).toMatch(/not in the list/);
    const chain: HostLayer[] = [];
    for (let i = 1; i <= 25; i++) chain.push(HL(i, { parent_id: i < 25 ? 100 + i + 1 : null }));
    expect(chainMatrix(chain[0], layerMap(chain)).reason).toMatch(/deeper than 20/);
  });
});

// ---------- boxes ----------

describe("layer boxes", () => {
  it("rotates the content rect about the anchor and gives the corner order and anchor", () => {
    const read = READ([HL(1, { transform: T({ anchor: [50, 25, 0], position: [200, 100, 0], rotation_z: 90 }) })]);
    const { box: b } = box(read, 1);
    expect(b!.projection).toBe("2d");
    near(b!.quad.flat(), [225, 50, 225, 150, 175, 150, 175, 50]);
    expect(b!.bbox).toEqual([175, 50, 225, 150]);
    expect(b!.anchor).toEqual([200, 100]);
  });

  it("follows a parent's transform", () => {
    const parent = HL(2, { name: "Rig", kind: "null", transform: T({ position: [300, 100, 0] }) });
    const kid = HL(1, { parent_id: parent.id, transform: T({ position: [10, 10, 0] }) });
    const read = READ([kid, parent]);
    expect(box(read, 1).box!.bbox).toEqual([310, 110, 410, 160]);
  });

  it("gives no box, with the reason, for layers that have none", () => {
    const cam = HL(1, { kind: "camera", rect: null, skip_reason: "cameras and lights have no picture" });
    const read = READ([cam]);
    expect(box(read, 1)).toEqual({ box: null, reason: "cameras and lights have no picture" });
    const noRect = HL(2, { rect: null });
    expect(box(READ([noRect]), 2).reason).toMatch(/no content rect/);
  });

  it("gives no box when the layer or a parent has Auto-Orient on", () => {
    const own = HL(1, { auto_orient_active: true });
    expect(box(READ([own]), 1)).toMatchObject({ box: null, reason: expect.stringMatching(/Auto-Orient/) });
    const parent = HL(2, { kind: "null", auto_orient_active: true });
    const kid = HL(1, { parent_id: parent.id });
    expect(box(READ([kid, parent]), 1).box).toBeNull();
    expect(box(READ([HL(1, { auto_orient_active: false })]), 1).box).not.toBeNull();
  });

  it("leaves a 2D layer under a 3D parent unmodelled", () => {
    const parent = HL(2, { kind: "null", three_d: true });
    const kid = HL(1, { parent_id: parent.id });
    const r = box(READ([kid, parent]), 1);
    expect(r.box).toBeNull();
    expect(r.reason).toMatch(/not modelled/);
  });
});

describe("3D projection", () => {
  const rect = { left: -100, top: -50, width: 200, height: 100 };
  const at = (z: number, over: Partial<HostTransform> = {}) =>
    HL(1, { three_d: true, rect, transform: T({ position: [500, 250, z], ...over }) });

  it("the default camera leaves a layer at z=0 where the 2D maths puts it", () => {
    const read = READ([at(0)]);
    const { box: b } = box(read, 1);
    expect(b!.projection).toBe("3d-estimated");
    near(b!.quad.flat(), [400, 200, 600, 200, 600, 300, 400, 300], 1e-6);
    near(b!.anchor!, [500, 250]);
  });

  it("the default camera sits one zoom in front, so z = zoom halves the size", () => {
    const zoom = (1000 * 50) / 36;
    expect(defaultCamera(1000, 500).zoom).toBeCloseTo(zoom, 9);
    const { box: b } = box(READ([at(zoom)]), 1);
    near(b!.quad.flat(), [450, 225, 550, 225, 550, 275, 450, 275], 1e-6);
  });

  it("a camera layer one zoom back is the same as no projection; further back shrinks", () => {
    const cam = (z: number, over: Partial<HostTransform> = {}) =>
      HL(2, { kind: "camera", three_d: true, rect: null, skip_reason: "cameras and lights have no picture", camera: { zoom: 2000, two_node: false }, transform: T({ position: [500, 250, z], ...over }) });
    let read = READ([at(0), cam(-2000)], { active_camera_id: 102 });
    near(box(read, 1).box!.quad.flat(), [400, 200, 600, 200, 600, 300, 400, 300], 1e-6);
    read = READ([at(0), cam(-4000)], { active_camera_id: 102 });
    near(box(read, 1).box!.quad.flat(), [450, 225, 550, 225, 550, 275, 450, 275], 1e-6);
  });

  it("a two-node camera aims at its point of interest", () => {
    const cam = HL(2, {
      kind: "camera",
      three_d: true,
      rect: null,
      skip_reason: "cameras and lights have no picture",
      camera: { zoom: 2000, two_node: true },
      transform: T({ position: [1500, 250, -1000], point_of_interest: [500, 250, 0] }),
    });
    const read = READ([at(0), cam], { active_camera_id: 102 });
    const { box: b } = box(read, 1);
    // The point of interest is the layer's anchor, so it lands on the middle of the frame.
    near(b!.anchor!, [500, 250], 1e-6);
    // The camera is to the right, so the layer's right edge is nearer and looks taller than its left edge.
    const [tl, tr, br, bl] = b!.quad;
    expect(Math.abs(br[1] - tr[1])).toBeGreaterThan(Math.abs(bl[1] - tl[1]) + 5);
  });

  it("a layer behind the camera has no box", () => {
    const r = box(READ([at(-5000)]), 1);
    expect(r.box).toBeNull();
    expect(r.reason).toMatch(/behind the camera/);
  });

  it("returns box null for a 3D layer unless include_3d is on", () => {
    const read = READ([at(0)]);
    expect(box(read, 1, false)).toEqual({ box: null, reason: "3D: needs a live check of the projection" });
    expect(box(read, 1, true).box).not.toBeNull();
  });

  it("uses the two-node aim for a camera that is a parent", () => {
    const cam = HL(2, {
      kind: "camera",
      three_d: true,
      rect: null,
      skip_reason: "cameras and lights have no picture",
      camera: { zoom: 2000, two_node: true },
      transform: T({ position: [1500, 250, -1000], point_of_interest: [500, 250, 0] }),
    });
    const kid = HL(1, { three_d: true, rect, parent_id: cam.id, transform: T({ position: [0, 0, 2000] }) });
    const byId = layerMap([kid, cam]);
    const withAim = chainMatrix(kid, byId).matrix!;
    const flat = chainMatrix(kid, layerMap([kid, { ...cam, camera: { zoom: 2000, two_node: false } }])).matrix!;
    expect(withAim).not.toEqual(flat);
    // The child sits 2000 along the camera's aim, so its origin is on the line to the point of interest.
    const o = transformPoint(withAim, [0, 0, 0]);
    expect(o[0]).toBeLessThan(1500);
  });

  it("falls back to the default camera with a note when the active camera was past the layer cap", () => {
    const read = READ([at(0)], { active_camera_id: 999, truncated: true, total_layers: 700 });
    const model = cameraModel(read, layerMap(read.layers));
    expect(model.source).toBe("default");
    expect(model.note).toMatch(/999.*past the 500 layers/);
  });

  it("notes when a camera's zoom could not be read and falls back to AE's default", () => {
    const cam = HL(2, { kind: "camera", three_d: true, rect: null, skip_reason: "x", camera: { zoom: null, two_node: false }, transform: T({ position: [500, 250, -1388.8889] }) });
    const read = READ([at(0), cam], { active_camera_id: 102 });
    const model = cameraModel(read, layerMap(read.layers));
    expect(model.note).toMatch(/zoom could not be read/);
    expect(model.source).toBe("layer");
  });
});

// ---------- selecting and the index ----------

describe("choosing layers and the index", () => {
  const layers = [
    HL(1, { selected: true }),
    HL(2, { visible: false }),
    HL(3, { kind: "camera", rect: null, skip_reason: "cameras and lights have no picture" }),
    HL(4, { kind: "null", visible: true, selected: true }),
  ];

  it("filters by visible, selected, all and layer ids", () => {
    // Nulls and guide layers draw no pixels, so the default mode leaves them out.
    expect(chooseLayers(layers, "visible").map((l) => l.index)).toEqual([1]);
    expect(chooseLayers([...layers, HL(5, { guide: true, visible: false })], "visible").map((l) => l.index)).toEqual([1]);
    expect(chooseLayers([HL(6, { guide: true, visible: true })], "visible")).toEqual([]);
    expect(chooseLayers(layers, "selected").map((l) => l.index)).toEqual([1, 4]);
    expect(chooseLayers(layers, "all").map((l) => l.index)).toEqual([1, 2, 3, 4]);
    expect(chooseLayers(layers, "all", [102, 103]).map((l) => l.index)).toEqual([2, 3]);
    expect(chooseLayers(layers, "visible", [101]).map((l) => l.index)).toEqual([1]);
  });

  it("indexes by layer number with id, name, parent index, reason and colour", () => {
    const parent = HL(5, { name: "Rig", kind: "null" });
    const kid = HL(2, { name: "Logo", parent_id: parent.id });
    const read = READ([kid, layers[2], parent]);
    const index = buildIndex(read, read.layers);
    expect(index.map((e) => e.n)).toEqual([2, 3, 5]);
    expect(index[0]).toMatchObject({ id: 102, name: "Logo", parent: 5, drawn: false });
    expect(index[0].color).toBe("#" + colorFor(2).slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join(""));
    expect(index[1]).toMatchObject({ box: null, reason: "cameras and lights have no picture" });
  });

  it("flags a layer whose box is entirely outside the frame", () => {
    const read = READ([HL(1, { transform: T({ position: [5000, 5000, 0] }) })]);
    expect(buildIndex(read, read.layers)[0].offscreen).toBe(true);
  });
});

// ---------- view, grid and tag helpers ----------

describe("view mapping", () => {
  it("shrinks a full frame to the budget and never enlarges it", () => {
    const big = makeView({ width: 3840, height: 2160 }, { width: 3840, height: 2160 }, undefined, 1600);
    expect(big.outW).toBe(1600);
    expect(big.outH).toBe(900);
    const small = makeView({ width: 640, height: 360 }, { width: 640, height: 360 }, undefined, 1600);
    expect(small.k).toBe(1);
    expect(small.outW).toBe(640);
  });

  it("takes the scale between comp and render from the decoded image", () => {
    // Half-resolution render of a 400x200 comp.
    const v = makeView({ width: 400, height: 200 }, { width: 200, height: 100 }, undefined, 1600);
    expect([v.isx, v.isy]).toEqual([0.5, 0.5]);
    expect(toOutput(v, 100, 40)).toEqual([50, 20]);
  });

  it("crops a zoom region from the full render and enlarges it up to 8x", () => {
    const v = makeView({ width: 1000, height: 500 }, { width: 1000, height: 500 }, { x: 100, y: 50, width: 100, height: 50 }, 1600);
    expect(v.region).toEqual({ x0: 100, y0: 50, x1: 200, y1: 100 });
    expect(v.k).toBe(8);
    expect([v.outW, v.outH]).toEqual([800, 400]);
    expect(toOutput(v, 150, 75)).toEqual([400, 200]);
  });

  it("clips a zoom region to the comp and refuses one that is outside it", () => {
    const v = makeView({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 50, y: -20, width: 500, height: 60 }, 800);
    expect(v.region).toEqual({ x0: 50, y0: 0, x1: 100, y1: 40 });
    expect(() => makeView({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 200, y: 0, width: 10, height: 10 }, 800)).toThrow(/outside/);
  });

  it("raises a grid spacing that would draw lines closer than 6 output pixels", () => {
    const v = makeView({ width: 1000, height: 500 }, { width: 1000, height: 500 }, undefined, 500);
    expect(v.k).toBe(0.5);
    expect(effectiveGridSpacing(100, v)).toBe(100);
    expect(effectiveGridSpacing(4, v)).toBe(12);
  });
});

describe("tags", () => {
  it("writes the number and the name in capitals, cut to 20 characters, with unknown characters marked", () => {
    expect(tagText(12, "Shape Layer 12")).toBe("12 SHAPE LAYER 12");
    expect(tagText(3, "Café logo")).toBe("3 CAF? LOGO");
    // The '?' stands in for a character the font lacks, so it must have a glyph of its own.
    const q = new PNG({ width: 12, height: 9 });
    drawText(q, "?", 0, 0, 1, [255, 255, 255, 255]);
    expect(Array.from(q.data).some((v) => v !== 0)).toBe(true);
    const t = tagText(1, "A very long layer name that goes on");
    expect(t).toBe("1 A VERY LONG LAYER N.");
    expect(t.length).toBeLessThanOrEqual(2 + 20);
  });

  it("the bitmap font now draws capitals", () => {
    const img = new PNG({ width: textWidth("A", 1), height: 7 });
    drawText(img, "A", 0, 0, 1, [255, 255, 255, 255]);
    const lit = Array.from({ length: img.width * 7 }).filter((_, i) => img.data[i * 4 + 3] > 0).length;
    expect(lit).toBeGreaterThan(10);
  });
});

// ---------- image helpers ----------

const solid = (w: number, h: number, rgba: [number, number, number, number]): PNG => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) p.data.set(rgba, i);
  return p;
};
const pixel = (p: PNG, x: number, y: number) => Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));

describe("image helpers", () => {
  it("crops, enlarges with crisp pixels and averages a region by alpha", () => {
    const p = solid(4, 2, [0, 0, 255, 255]);
    p.data.set([255, 0, 0, 255], (0 * 4 + 3) * 4);
    const c = cropImage(p, 2, 0, 2, 2);
    expect([c.width, c.height]).toEqual([2, 2]);
    expect(pixel(c, 1, 0)).toEqual([255, 0, 0, 255]);
    const up = scaleNearest(c, 4, 4);
    expect(pixel(up, 3, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(up, 1, 0)).toEqual([0, 0, 255, 255]);

    const half = solid(2, 1, [200, 100, 50, 255]);
    half.data.set([0, 0, 0, 0], 4); // transparent pixel must not darken the mean
    const s = regionStats(half, 0, 0, 2, 1);
    expect(s.mean_rgb).toEqual([200, 100, 50]);
    expect(s.alpha_mean).toBe(0.5);
    expect(s.hex).toBe("#c86432");
  });

  it("grid stats give mean colour and luma per cell, in comp pixels", () => {
    const img = solid(100, 50, [0, 0, 255, 255]);
    for (let y = 0; y < 50; y++) for (let x = 50; x < 100; x++) img.data.set([255, 255, 255, 255], (y * 100 + x) * 4);
    const view = makeView({ width: 200, height: 100 }, { width: 100, height: 50 }, undefined, 1600);
    const cells = gridStats(img, view, 2, 1);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ col: 0, row: 0, rect: [0, 0, 100, 100], mean_rgb: [0, 0, 255], hex: "#0000ff" });
    expect(cells[0].luma).toBeCloseTo(0.0722, 3);
    expect(cells[1]).toMatchObject({ mean_rgb: [255, 255, 255], luma: 1 });
  });

  it("puts two images side by side under a header", () => {
    const out = composePair(solid(50, 30, [255, 0, 0, 255]), solid(50, 30, [0, 255, 0, 255]), "A 1.00s", "B 2.00s");
    expect(out.width).toBe(50 * 2 + 8);
    expect(out.height).toBeGreaterThan(30);
    expect(pixel(out, 5, out.height - 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 50 + 8 + 5, out.height - 2)).toEqual([0, 255, 0, 255]);
  });
});

// ---------- drawing ----------

const DRAW: DrawOptions = {
  outlines: true,
  tags: true,
  anchors: true,
  safeAreas: false,
  actionSafe: 0.1,
  titleSafe: 0.2,
  rulers: true,
  checkerboard: true,
};

describe("drawing", () => {
  it("draws the outline in the layer's colour, marks it drawn and leaves other pixels alone", () => {
    const read = READ([HL(1, { transform: T({ position: [50, 50, 0] }) })], {}, { width: 400, height: 200 });
    const img = new PNG({ width: 200, height: 100 });
    img.data.fill(0);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const view = makeView(read.comp, img, undefined, 1600);
    const index = buildIndex(read, read.layers);
    const base = renderBase(img, view, true);
    drawAnnotations(base, view, read.comp, index, DRAW);
    expect(index[0].drawn).toBe(true);
    // Box is [50,50,150,100] in the comp = [25,25,75,50] in the half-size output.
    expect(pixel(base, 50, 25)).toEqual(Array.from(colorFor(1)));
    expect(pixel(base, 150, 80)).toEqual([0, 0, 0, 255]);
  });

  it("skips outlines, tags and anchors when turned off", () => {
    const read = READ([HL(1, { transform: T({ position: [50, 50, 0] }) })], {}, { width: 400, height: 200 });
    const img = solid(400, 200, [0, 0, 0, 255]);
    const view = makeView(read.comp, img, undefined, 1600);
    const index = buildIndex(read, read.layers);
    const base = renderBase(img, view, true);
    drawAnnotations(base, view, read.comp, index, { ...DRAW, outlines: false, tags: false, anchors: false });
    expect(Array.from(base.data).every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
  });

  it("does not draw a layer that lies outside the zoomed view", () => {
    const read = READ([HL(1, { transform: T({ position: [800, 400, 0] }) })]);
    const img = solid(1000, 500, [0, 0, 0, 255]);
    const view = makeView(read.comp, img, { x: 0, y: 0, width: 200, height: 100 }, 1600);
    const index = buildIndex(read, read.layers);
    drawAnnotations(renderBase(img, view, true), view, read.comp, index, DRAW);
    expect(index[0].drawn).toBe(false);
  });

  it("shows transparency as a checkerboard and draws the safe areas and grid", () => {
    const img = solid(200, 100, [0, 0, 0, 0]);
    const view = makeView({ width: 200, height: 100 }, img, undefined, 1600);
    const base = renderBase(img, view, true);
    expect(pixel(base, 1, 1)[3]).toBe(255);
    expect(pixel(base, 1, 1)).not.toEqual(pixel(base, 9, 1));
    const flat = renderBase(img, view, false);
    expect(pixel(flat, 1, 1)[3]).toBe(0);
    const before = Buffer.from(base.data);
    drawAnnotations(base, view, { width: 200, height: 100 }, [], { ...DRAW, safeAreas: true, grid: 50 });
    expect(Buffer.compare(before, base.data)).not.toBe(0);
    // The action-safe line is 5% in from the left edge: x = 10 (clear of the grid lines at y = 50).
    expect(pixel(base, 10, 30)).toEqual([64, 224, 64, 255]);
  });
});

// ---------- the tool against a fake bridge ----------

describe("ae_annotate_frame handler", () => {
  const tmpDirs: string[] = [];
  const origLocalAppData = process.env.LOCALAPPDATA;
  const origHome = process.env.HOME;
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-annotate-"));
    tmpDirs.push(d);
    return d;
  };
  beforeEach(() => {
    process.env.LOCALAPPDATA = process.env.HOME = tmp();
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = origLocalAppData;
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** AE answers annotateRead from `reads` and writes `render(i)` for each snapshotFrame. */
  function fakeAe(reads: HostRead[], render: (i: number) => PNG) {
    const calls: Array<{ fn: string; args: any }> = [];
    const dir = tmp();
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    let snap = 0;
    let read = 0;
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
        calls.push({ fn, args });
        if (fn === "annotateRead") return { ok: true, result: reads[Math.min(read++, reads.length - 1)], durationMs: 1 };
        if (fn === "snapshotFrame") {
          fs.mkdirSync(path.dirname(args.output_path), { recursive: true });
          fs.writeFileSync(args.output_path, PNG.sync.write(render(snap++)));
          return { ok: true, result: { path: args.output_path }, durationMs: 1 };
        }
        throw new Error(`Unexpected script: ${script}`);
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    return { ctx, calls };
  }

  const half = (rgbaLeft: [number, number, number, number], rgbaRight: [number, number, number, number]) => () => {
    const p = solid(200, 100, rgbaLeft);
    for (let y = 0; y < 100; y++) for (let x = 100; x < 200; x++) p.data.set(rgbaRight, (y * 200 + x) * 4);
    return p;
  };

  const read400 = (over: Partial<HostRead> = {}) =>
    READ([HL(1, { transform: T({ position: [50, 50, 0] }) }), HL(2, { name: "Hidden", visible: false })], over, { width: 400, height: 200 });

  it("reads the transforms, then renders, and touches nothing else", async () => {
    const { ctx, calls } = fakeAe([read400()], half([0, 0, 255, 255], [255, 0, 0, 255]));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1 }), ctx)) as Record<string, any>;
    // Two evalScripts, in that order: no guard check, no write, no checkpoint.
    expect(calls.map((c) => c.fn)).toEqual(["annotateRead", "snapshotFrame"]);
    expect(calls[0].args).toEqual({ comp_id: 1, time: 1, include_extents: false });
    // The render is taken at the time the read settled on.
    expect(calls[1].args.time).toBe(1);

    expect(res).toMatchObject({ ok: true, read_only: true, mode: "single", width: 200, height: 100 });
    expect(res.view).toMatchObject({ region: [0, 0, 400, 200], render_size: [200, 100], render_scale: [0.5, 0.5] });
    const png = PNG.sync.read(fs.readFileSync(res.path));
    expect([png.width, png.height]).toEqual([200, 100]);
    expect(pixel(png, 50, 25)).toEqual(Array.from(colorFor(1)));

    const frame = res.frames[0];
    expect(frame.layers).toHaveLength(1);
    expect(frame.layers[0]).toMatchObject({ n: 1, id: 101, name: "Layer 1", drawn: true });
    expect(frame.layers[0].box.bbox).toEqual([50, 50, 150, 100]);
    expect(frame.stats[0].mean_rgb).toEqual([0, 0, 255]);
    expect(frame.stats[2]).toMatchObject({ col: 0, row: 1 });
    expect(res.notes.join(" ")).toMatch(/content rect/);
  });

  it("lists every layer for `all`, and only the chosen ids", async () => {
    let { ctx } = fakeAe([read400()], half([0, 0, 0, 255], [0, 0, 0, 255]));
    let res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, layers: "all", stats: false }), ctx)) as Record<string, any>;
    expect(res.frames[0].layers.map((l: any) => l.n)).toEqual([1, 2]);
    expect(res.frames[0].stats).toBeUndefined();
    ({ ctx } = fakeAe([read400()], half([0, 0, 0, 255], [0, 0, 0, 255])));
    res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, layers: "all", layer_ids: [102] }), ctx)) as Record<string, any>;
    expect(res.frames[0].layers.map((l: any) => l.n)).toEqual([2]);
  });

  it("says when no layer matches", async () => {
    const { ctx } = fakeAe([read400()], half([0, 0, 0, 255], [0, 0, 0, 255]));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, layers: "selected" }), ctx)) as Record<string, any>;
    expect(res.frames[0].layers).toEqual([]);
    expect(res.frames[0].notes[0]).toMatch(/No layers matched/);
  });

  it("zooms into a region of the full-size render with its own stats", async () => {
    const { ctx } = fakeAe([read400()], half([0, 0, 255, 255], [255, 0, 0, 255]));
    const res = (await tool.handler(
      AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, zoom: { x: 0, y: 0, width: 100, height: 100 }, grid: 25, stats_cols: 1, stats_rows: 1 }),
      ctx
    )) as Record<string, any>;
    // 100x100 comp px is 50x50 of the half-size render, enlarged 8x.
    expect([res.width, res.height]).toEqual([400, 400]);
    expect(res.view.region).toEqual([0, 0, 100, 100]);
    expect(res.view.scale).toBe(8);
    expect(res.grid_spacing).toBe(25);
    expect(res.frames[0].stats[0].mean_rgb).toEqual([0, 0, 255]);
    expect(res.frames[0].stats[0].rect).toEqual([0, 0, 100, 100]);
  });

  it("makes a pair from two reads and two renders, each frame with its own layers", async () => {
    const readB = read400({ time: 2 });
    readB.layers[0].transform = T({ position: [250, 50, 0] });
    const { ctx, calls } = fakeAe([read400(), readB], (i) => (i === 0 ? solid(200, 100, [0, 0, 255, 255]) : solid(200, 100, [255, 0, 0, 255])));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, time_b: 2 }), ctx)) as Record<string, any>;
    expect(calls.map((c) => c.fn)).toEqual(["annotateRead", "snapshotFrame", "annotateRead", "snapshotFrame"]);
    expect(calls[2].args.time).toBe(2);
    expect(res.mode).toBe("pair");
    expect(res.width).toBe(200 * 2 + 8);
    expect(res.frames.map((f: any) => [f.label, f.time])).toEqual([["A", 1], ["B", 2]]);
    expect(res.frames[0].layers[0].box.bbox[0]).toBe(50);
    expect(res.frames[1].layers[0].box.bbox[0]).toBe(250);
    expect(res.frames[1].stats[0].mean_rgb).toEqual([255, 0, 0]);
  });

  it("shrinks to max_size before drawing", async () => {
    const read = READ([HL(1)], {}, { width: 1000, height: 500 });
    const { ctx } = fakeAe([read], () => solid(1000, 500, [10, 10, 10, 255]));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, max_size: 500 }), ctx)) as Record<string, any>;
    expect([res.width, res.height]).toEqual([500, 250]);
  });

  it("leaves 3D layers unboxed by default, with the reason", async () => {
    const read = READ([HL(1, { three_d: true, rect: { left: -100, top: -50, width: 200, height: 100 }, transform: T({ position: [500, 250, 0] }) })]);
    const { ctx } = fakeAe([read], () => solid(1000, 500, [10, 10, 10, 255]));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1 }), ctx)) as Record<string, any>;
    expect(res.frames[0].layers[0]).toMatchObject({ box: null, reason: "3D: needs a live check of the projection" });
    expect(res.notes.join(" ")).not.toMatch(/estimate/);
  });

  it("with include_3d notes the camera used and that the projection is an estimate", async () => {
    const read = READ([HL(1, { three_d: true, rect: { left: -100, top: -50, width: 200, height: 100 }, transform: T({ position: [500, 250, 0] }) })]);
    const { ctx } = fakeAe([read], () => solid(1000, 500, [10, 10, 10, 255]));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, include_3d: true }), ctx)) as Record<string, any>;
    expect(res.frames[0].layers[0].box.projection).toBe("3d-estimated");
    expect(res.frames[0].notes.join(" ")).toMatch(/default comp camera/);
    expect(res.notes.join(" ")).toMatch(/estimate/);
  });

  it("refuses a zoom region outside the comp with a plain error, before any render", async () => {
    const { ctx, calls } = fakeAe([read400()], half([0, 0, 0, 255], [0, 0, 0, 255]));
    await expect(
      tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, zoom: { x: 900, y: 900, width: 10, height: 10 } }), ctx)
    ).rejects.toThrow(/outside/);
    expect(calls.map((c) => c.fn)).toEqual(["annotateRead"]);
  });

  it("carries truncated and total_layers, and says why requested layer_ids are missing", async () => {
    const read = read400({ truncated: true, total_layers: 742 });
    const { ctx } = fakeAe([read], half([0, 0, 0, 255], [0, 0, 0, 255]));
    const res = (await tool.handler(
      AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, layers: "visible", layer_ids: [101, 102, 742] }),
      ctx
    )) as Record<string, any>;
    expect(res.truncated).toBe(true);
    expect(res.frames[0]).toMatchObject({ truncated: true, total_layers: 742 });
    const why = Object.fromEntries(res.frames[0].missing_layer_ids.map((m: any) => [m.id, m.reason]));
    expect(why[742]).toBe("not_read_layer_cap_or_not_in_comp");
    expect(why[102]).toBe("filtered_out_by_layers");
    expect(why[101]).toBeUndefined();
  });

  it("reports ids that are not in a complete read as not_in_comp", async () => {
    const { ctx } = fakeAe([read400()], half([0, 0, 0, 255], [0, 0, 0, 255]));
    const res = (await tool.handler(AeAnnotateFrameSchema.parse({ comp_id: 1, time: 1, layers: "all", layer_ids: [101, 999] }), ctx)) as Record<string, any>;
    expect(res.truncated).toBe(false);
    expect(res.frames[0].missing_layer_ids).toEqual([{ id: 999, reason: "not_in_comp" }]);
  });
});

// ---------- the host function under node:vm ----------

describe("annotate.jsx", () => {
  function scene() {
    const project = new FakeProject();
    const comp = project.addComp("Main", 640, 360, 4);
    const bg = comp.layers.addSolid([0, 0, 0], "BG", 640, 360, 1);
    const logo = comp.layers.addSolid([1, 1, 1], "Logo", 100, 50, 1);
    logo.transform("ADBE Anchor Point").setValue([50, 25, 0]);
    logo.transform("ADBE Position").setValue([200, 100, 0]);
    logo.transform("ADBE Rotate Z").setValue(90);
    const rig = comp.layers.addNull();
    logo.parent = rig;
    return { project, comp, bg, logo, rig };
  }

  it("reads every layer's transform and rect at the time, bottom to top by index", () => {
    const { project, comp, logo, rig } = scene();
    const { A, undo } = loadHost(project, ["annotate.jsx"]);
    const res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.comp).toMatchObject({ id: comp.id, name: "Main", width: 640, height: 360, pixel_aspect: 1, fps: 25 });
    expect(res.time).toBe(1);
    expect(res.layers.map((l: any) => [l.index, l.name, l.kind])).toEqual([
      [1, "Null 1", "null"],
      [2, "Logo", "solid"],
      [3, "BG", "solid"],
    ]);
    const l = res.layers[1];
    expect(l).toMatchObject({ id: logo.id, parent_id: rig.id, three_d: false, visible: true, selected: false, skip_reason: null });
    expect(l.transform).toMatchObject({ anchor: [50, 25, 0], position: [200, 100, 0], scale: [100, 100, 100], rotation_z: 90 });
    expect(l.rect).toEqual({ left: 0, top: 0, width: 100, height: 50 });
    // The fake has no activeAtTime, so the host reports it unknown rather than guessing.
    expect(l.active_at_time).toBeNull();
    // Read only: not one undo group.
    expect(undo.begun).toBe(0);
  });

  it("feeds buildIndex to the same box the maths gives by hand", () => {
    const { project, comp, rig } = scene();
    rig.transform("ADBE Position").setValue([0, 0, 0]);
    const { A } = loadHost(project, ["annotate.jsx"]);
    const read = plain(A.annotateRead({ comp_id: comp.id, time: 0 })) as HostRead;
    const index = buildIndex(read, chooseLayers(read.layers, "all", [read.layers[1].id]));
    near(index[0].box!.quad.flat(), [225, 50, 225, 150, 175, 150, 175, 50]);
    expect(index[0].parent).toBe(1);
  });

  it("changes nothing: time, selection and the undo stack stay as they were", () => {
    const { project, comp, logo } = scene();
    (comp as any).time = 1.5;
    (comp as any).selectedLayers = [logo];
    (comp as any).resolutionFactor = [2, 2];
    const { A, undo } = loadHost(project, ["annotate.jsx"]);
    const res = plain(A.annotateRead({ comp_id: comp.id, time: 3 }));
    expect(comp.time).toBe(1.5);
    expect((comp as any).resolutionFactor).toEqual([2, 2]);
    expect((comp as any).selectedLayers).toEqual([logo]);
    expect(undo.begun).toBe(0);
    expect(res.comp.resolution_factor).toEqual([2, 2]);
    expect(res.layers.filter((l: any) => l.selected).map((l: any) => l.name)).toEqual(["Logo"]);
  });

  it("clamps the time to the last frame", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["annotate.jsx"]);
    expect(plain(A.annotateRead({ comp_id: comp.id, time: 99 })).time).toBeCloseTo(4 - 1 / 25, 9);
    expect(plain(A.annotateRead({ comp_id: comp.id, time: -3 })).time).toBe(0);
  });

  it("works out visibility from enabled, in/out range and solo, and uses activeAtTime when it exists", () => {
    const { project, comp, bg, logo } = scene();
    logo.enabled = false;
    bg.outPoint = 1;
    const { A } = loadHost(project, ["annotate.jsx"]);
    let res = plain(A.annotateRead({ comp_id: comp.id, time: 2 }));
    expect(Object.fromEntries(res.layers.map((l: any) => [l.name, l.visible]))).toEqual({ "Null 1": true, Logo: false, BG: false });
    // Solo on one layer hides the others.
    (logo as any).enabled = true;
    (logo as any).solo = true;
    bg.outPoint = 4;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 2 }));
    expect(res.solo_active).toBe(true);
    expect(Object.fromEntries(res.layers.map((l: any) => [l.name, l.visible]))).toEqual({ "Null 1": false, Logo: true, BG: false });
    (logo as any).activeAtTime = () => true;
    (bg as any).activeAtTime = () => false;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 2 }));
    expect(res.layers.find((l: any) => l.name === "BG").active_at_time).toBe(false);
    expect(res.layers.find((l: any) => l.name === "Logo").active_at_time).toBe(true);
  });

  it("leaves guide layers out of visible, and a soloed camera does not hide the picture layers", () => {
    const { project, comp, logo, bg } = scene();
    (bg as any).guideLayer = true;
    const cam = comp.layers.addCamera("Cam 1");
    (cam as any).solo = true;
    const { A } = loadHost(project, ["annotate.jsx"]);
    const res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.solo_active).toBe(false);
    const by = Object.fromEntries(res.layers.map((l: any) => [l.name, l]));
    expect(by.BG).toMatchObject({ guide: true, visible: false });
    expect(by.Logo).toMatchObject({ guide: false, visible: true });
    expect(logo.name).toBe("Logo");
  });

  it("gives a camera its zoom, point of interest, rotation and the active camera id, and no rect", () => {
    const { project, comp, logo } = scene();
    const cam = comp.layers.addCamera("Cam 1");
    cam.threeDLayer = true;
    const tr = cam.group.property("ADBE Transform Group") as FakeGroup;
    tr.props.push(
      new FakeProperty("Point of Interest", "ADBE Point of Interest", PropertyValueType.ThreeD_SPATIAL, [320, 180, 0], true),
      new FakeProperty("X Rotation", "ADBE Rotate X", PropertyValueType.OneD, 10),
      new FakeProperty("Orientation", "ADBE Orientation", PropertyValueType.ThreeD, [1, 2, 3])
    );
    cam.group.props.push(new FakeGroup("Camera Options", "ADBE Camera Options Group", [new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, 1500)]));
    const { A, G } = loadHost(project, ["annotate.jsx"]);
    let res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    const c = res.layers.find((l: any) => l.name === "Cam 1");
    expect(c).toMatchObject({ kind: "camera", three_d: true, rect: null, skip_reason: "cameras and lights have no picture" });
    expect(c.camera).toEqual({ zoom: 1500, two_node: true });
    expect(c.transform).toMatchObject({ point_of_interest: [320, 180, 0], rotation_x: 10, orientation: [1, 2, 3] });
    expect(res.active_camera_id).toBe(cam.id);

    // A camera whose auto-orient is off is a one-node camera even if a POI property exists.
    G.AutoOrientType = { CAMERA_OR_POINT_OF_INTEREST: 7 };
    (cam as any).autoOrient = 0;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.layers.find((l: any) => l.name === "Cam 1").camera.two_node).toBe(false);

    // Layers report whether Auto-Orient is on; cameras are exempt.
    G.AutoOrientType = { CAMERA_OR_POINT_OF_INTEREST: 7, NO_AUTO_ORIENT: 4 };
    (logo as any).autoOrient = 4;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.layers.find((l: any) => l.name === "Logo").auto_orient_active).toBe(false);
    expect(res.layers.find((l: any) => l.name === "Cam 1").auto_orient_active).toBe(false);
    (logo as any).autoOrient = 3;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.layers.find((l: any) => l.name === "Logo").auto_orient_active).toBe(true);

    // A light's aim is not modelled, so a light with Auto-Orient on reports it.
    const light = comp.layers.addLight("Light 1");
    (light as any).autoOrient = 7;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.layers.find((l: any) => l.name === "Light 1")).toMatchObject({ kind: "light", auto_orient_active: true });
    (light as any).autoOrient = 4;
    res = plain(A.annotateRead({ comp_id: comp.id, time: 1 }));
    expect(res.layers.find((l: any) => l.name === "Light 1").auto_orient_active).toBe(false);

    // Outside its in/out range it is not the active camera.
    cam.outPoint = 0.5;
    expect(plain(A.annotateRead({ comp_id: comp.id, time: 1 })).active_camera_id).toBeNull();
  });

  it("keeps working when a transform property is missing or a rect read fails", () => {
    const { project, comp, logo } = scene();
    (logo as any).sourceRectAtTime = () => {
      throw new Error("boom");
    };
    const tr = logo.group.property("ADBE Transform Group") as FakeGroup;
    tr.props = tr.props.filter((p) => p.matchName !== "ADBE Scale");
    const { A } = loadHost(project, ["annotate.jsx"]);
    const l = plain(A.annotateRead({ comp_id: comp.id, time: 0 })).layers.find((x: any) => x.name === "Logo");
    expect(l.rect).toBeNull();
    expect(l.skip_reason).toMatch(/sourceRectAtTime failed: boom/);
    expect(l.transform.scale).toEqual([100, 100, 100]);
  });

  it("passes include_extents on to sourceRectAtTime and caps the list at 500", () => {
    const { project, comp, logo } = scene();
    const seen: unknown[] = [];
    (logo as any).sourceRectAtTime = (_t: number, ext: unknown) => {
      seen.push(ext);
      return { left: 0, top: 0, width: 1, height: 1 };
    };
    const { A } = loadHost(project, ["annotate.jsx"]);
    A.annotateRead({ comp_id: comp.id, time: 0, include_extents: true });
    A.annotateRead({ comp_id: comp.id, time: 0 });
    expect(seen).toEqual([true, false]);

    const big = project.addComp("Big", 64, 36, 1);
    for (let i = 0; i < 520; i++) big.layers.addNull();
    const res = plain(A.annotateRead({ comp_id: big.id, time: 0 }));
    expect(res.layers).toHaveLength(500);
    expect(res).toMatchObject({ truncated: true, total_layers: 520 });
  });

  it("fails clearly for a comp that does not exist", () => {
    const { project } = scene();
    const { A } = loadHost(project, ["annotate.jsx"]);
    expect(() => A.annotateRead({ comp_id: 424242, time: 0 })).toThrow(/No CompItem/);
  });
});
