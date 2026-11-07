/**
 * ae_layout_apply: the plan builder (pure), the host (panel/host/ext/placement.jsx
 * under node:vm against test/support/fake-ae.ts) and the tool end to end with a
 * bridge that runs the real host code. Nothing here touches After Effects.
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
  AeLayoutApplySchema,
  buildLayoutPlan,
  factsRequest,
  hostPlan,
  layoutMismatches,
  placementTools,
  trimLayoutReceipt,
  rectFromTemplate,
  type LayoutApplyArgs,
  type LayoutFacts,
} from "../src/tools/ext/placement.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { FakeFootage, FakeGroup, FakeLayer, FakeProject, FakeProperty, FileSource, GUARD, MaskMode, PropertyValueType, Shape, loadHost, type FakeComp } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214 };
const tool = placementTools[0];
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v));

class Footage extends FakeFootage {
  hasVideo = true;
  pixelAspect = 1;
}

function mkFootage(project: FakeProject, name: string, w: number, h: number): Footage {
  const f = new Footage(name, w, h, new FileSource());
  f.project = project;
  f.parentFolder = project.rootFolder;
  project.all.push(f);
  return f;
}

function addCameraOptions(cam: FakeLayer, zoom: number) {
  const opts = new FakeGroup("Camera Options", "ADBE Camera Options Group", [new FakeProperty("Zoom", "ADBE Camera Zoom", PropertyValueType.OneD, zoom)]);
  opts.parentProperty = cam.group;
  cam.group.props.push(opts);
}

/** A project with footage, comps to feed in, and comps holding cinema-style cameras. */
function stage() {
  const project = new FakeProject();
  const f1 = mkFootage(project, "plate1.mov", 1920, 1080);
  const f2 = mkFootage(project, "plate2.mov", 1280, 720);
  const c1 = project.addComp("Feed Src", 640, 360, 4) as FakeComp;
  const camA = project.addComp("C4D 1", 1920, 1080, 4) as FakeComp;
  const camera = camA.layers.addCamera("Camera 1", [960, 540]) as FakeLayer;
  addCameraOptions(camera, 1500);
  // A camera's point of interest is its Anchor Point stream; two nodes is its auto-orient.
  camera.transform("Anchor Point").setValue([960, 540, 0]);
  (camera as any).autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
  const destA = project.addComp("Tpl A", 1920, 1080, 4) as FakeComp;
  const destB = project.addComp("Tpl B", 1920, 1080, 4) as FakeComp;
  const host = loadHost(project, ["describe.jsx", "placement.jsx"]);
  Object.assign(host.G, { AutoOrientType });
  return { project, f1, f2, c1, camA, camera, destA, destB, ...host };
}
type Stage = ReturnType<typeof stage>;

/** The server's planning, run against the host's own facts and template reads. */
function planFor(s: Stage, args: LayoutApplyArgs) {
  const req = factsRequest(args);
  const facts = clean(s.A.layoutFacts({ ...req, expect: GUARD })) as LayoutFacts;
  const templates: Record<string, any> = {};
  for (const r of args.regions ?? []) {
    if (!r.from) continue;
    const key = String(r.from.time ?? args.time ?? "now");
    if (!templates[key]) templates[key] = clean(s.A.describeRead({ comp_id: args.comp_id, layout: true, layout_time: key === "now" ? undefined : Number(key), max_layers: 500 })).layers;
  }
  return buildLayoutPlan(args, facts, templates);
}

const parse = (v: object) => AeLayoutApplySchema.parse({ expect: GUARD, ...v });

const master = { name: "T Master", width: 1920, height: 1080, fps: 25, duration: 4 };

function bigSpec(s: Stage) {
  return parse({
    create_master: master,
    regions: [
      { name: "Wall", rect: [0, 0, 960, 540], content: { comp_id: s.c1.id } },
      { name: "Floor", rect: [0, 540, 1920, 540], content: { footage_id: s.f1.id }, fit: "contain" },
      { name: "Left feed", rect: [960, 0, 480, 540], content: { footage_id: s.f2.id, make_feed: { name: "Feed Left" } } },
      { name: "Right feed", rect: [1440, 0, 480, 540], content: { footage_id: s.f1.id, make_feed: { name: "Feed Right", fit: "contain" } } },
    ],
    copies: [
      { from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destA.id },
      { from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destB.id, name: "Cam B" },
    ],
  });
}

// ---------- schema ----------

describe("AeLayoutApplySchema", () => {
  it("needs exactly one of comp_id and create_master, and regions or copies", () => {
    const rect = [0, 0, 10, 10];
    const region = { name: "A", rect, content: { comp_id: 1 } };
    expect(AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1, regions: [region] }).success).toBe(true);
    expect(AeLayoutApplySchema.safeParse({ expect: GUARD, regions: [region] }).success).toBe(false);
    expect(AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1, create_master: master, regions: [region] }).success).toBe(false);
    expect(AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1 }).success).toBe(false);
    expect(AeLayoutApplySchema.safeParse({ comp_id: 1, regions: [region] }).success).toBe(false);
  });

  it("a region has a rect or a from, never both; above or below, never both; unknown keys are refused", () => {
    const ok = (r: object) => AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1, regions: [{ name: "A", content: { comp_id: 1 }, ...r }] }).success;
    expect(ok({ rect: [0, 0, 10, 10] })).toBe(true);
    expect(ok({ from: { layer: { name: "S" }, use: "bounds" } })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ rect: [0, 0, 10, 10], from: { layer: { name: "S" }, use: "bounds" } })).toBe(false);
    expect(ok({ rect: [0, 0, 0, 10] })).toBe(false);
    expect(ok({ rect: [0, 0, 10, 10], above: { name: "A" }, below: { name: "B" } })).toBe(false);
    expect(ok({ rect: [0, 0, 10, 10], above: { name: "A" } })).toBe(true);
    expect(ok({ rect: [0, 0, 10, 10], colour: "red" })).toBe(false);
    expect(ok({ rect: [0, 0, 10, 10], fit: "cover" })).toBe(false);
    expect(ok({ rect: [0, 0, 10, 10], align: [0, 2] })).toBe(false);
  });

  it("content takes one of its four shapes, and caps the counts at 100", () => {
    const ok = (content: object) => AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1, regions: [{ name: "A", rect: [0, 0, 5, 5], content }] }).success;
    expect(ok({ comp_id: 2 })).toBe(true);
    expect(ok({ footage_id: 2 })).toBe(true);
    expect(ok({ layer: { name: "L" } })).toBe(true);
    expect(ok({ footage_id: 2, make_feed: { name: "F" } })).toBe(true);
    expect(ok({ comp_id: 2, footage_id: 3 })).toBe(false);
    expect(ok({ comp_id: 2, make_feed: { name: "F" } })).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `R${i}`, rect: [0, 0, 5, 5], content: { comp_id: 2 } }));
    expect(AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1, regions: many }).success).toBe(false);
    expect(AeLayoutApplySchema.safeParse({ expect: GUARD, comp_id: 1, regions: many.slice(0, 100) }).success).toBe(true);
  });

  it("is registered, auto-checkpointed, and its description ends with the safety guidance", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_layout_apply")).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_layout_apply");
    expect(tool.description).toMatch(/verified: false/);
    expect(tool.description.endsWith("(3) Jay may be editing live in After Effects, so a target guard failure (kind: 'guard') means STOP and re-read state—do NOT retry with stale expectations.")).toBe(true);
  });
});

// ---------- the plan (pure, synthetic facts) ----------

const facts = (over: Partial<LayoutFacts> = {}): LayoutFacts => ({
  target: { id: 10, name: "Tpl", width: 1920, height: 1080, pixel_aspect: 1, fps: 25, duration: 4, num_layers: 0 },
  items: {
    "20": { id: 20, name: "Plate", kind: "footage", width: 1920, height: 1080, pixel_aspect: 1, has_video: true },
    "21": { id: 21, name: "Sub", kind: "comp", width: 640, height: 360, pixel_aspect: 1, has_video: true, contains_target: false },
    "22": { id: 22, name: "Holder", kind: "comp", width: 640, height: 360, pixel_aspect: 1, has_video: true, contains_target: true },
    "23": { id: 23, name: "Wide", kind: "footage", width: 720, height: 486, pixel_aspect: 0.9, has_video: true },
    "30": { id: 30, name: "Cams", kind: "comp", width: 1920, height: 1080, pixel_aspect: 1, has_video: true, contains_target: false },
    "10": { id: 10, name: "Tpl", kind: "comp", width: 1920, height: 1080, pixel_aspect: 1, has_video: true, contains_target: true },
  },
  layers: [],
  folders: {},
  ...over,
});

const layerFact = (key: string, over: object = {}) => ({ key, comp_id: 10, found: true, id: 77, index: 1, name: "Slot", locked: false, three_d: false, parent: null, kind: "layer" as const, keyed: 0, effects: 0, source_width: 640, source_height: 360, source_pixel_aspect: 1, ...over });

describe("buildLayoutPlan", () => {
  const spec = (regions: object[], extra: object = {}) => parse({ comp_id: 10, regions, ...extra });

  it("works out scale, position, clip and the covered box for every region", () => {
    const args = spec([
      { name: "A", rect: [0, 0, 960, 540], content: { comp_id: 21 } },
      { name: "B", rect: [0, 540, 960, 300], content: { footage_id: 20 }, fit: "contain", clip: true },
    ]);
    const { problems, plan } = buildLayoutPlan(args, facts());
    expect(problems).toEqual([]);
    expect(plan.regions[0]).toMatchObject({ fit: "fill", clip: true, layer_rect: [0, 0, 960, 540] });
    expect(plan.regions[0].placement.scale).toEqual([150, 150]);
    expect(plan.regions[0].clip_corners).toEqual([[0, 0], [640, 0], [640, 360], [0, 360]]);
    expect(plan.regions[1].fit).toBe("contain");
    expect(plan.regions[1].layer_rect[0]).toBeCloseTo(213.3333, 3);
    expect(plan.regions[1].layer_rect[1]).toBeCloseTo(540, 2);
    expect(plan.regions[1].layer_rect[2]).toBeCloseTo(533.3333, 2);
    expect(plan.regions[1].layer_rect[3]).toBeCloseTo(300, 2);
    expect(plan.regions[1].clip).toBe(true);
    expect(plan.regions[0].content).toMatchObject({ kind: "comp", item_id: 21, size: [640, 360] });
  });

  it("plans a feed comp at the region's rounded size and warns when rounding moved it off 100 %", () => {
    const args = spec([{ name: "F", rect: [0, 0, 480.4, 540.4], content: { footage_id: 20, make_feed: { name: "Feed" } } }]);
    const { problems, plan } = buildLayoutPlan(args, facts());
    expect(problems).toEqual([]);
    expect(plan.regions[0].feed).toMatchObject({ name: "Feed", width: 480, height: 540 });
    expect(plan.regions[0].content).toMatchObject({ kind: "feed", footage_id: 20, size: [1920, 1080] });
    expect(plan.regions[0].placement.scale[0]).toBeGreaterThan(100);
    expect(plan.warnings.join(" ")).toMatch(/whole-pixel/);
    expect(plan.feed_fps).toBe(25);
    expect(plan.feed_duration).toBe(4);
  });

  it("lists every problem at once: duplicate name, self-containing comp, bad pixel aspect, a short rectangle", () => {
    const args = spec([
      { name: "A", rect: [0, 0, 100, 100], content: { comp_id: 22 } },
      { name: "A", rect: [0, 0, 100, 100], content: { footage_id: 23 } },
      { name: "B", rect: [0, 0, 0.5, 100], content: { comp_id: 21 } },
      { name: "C", rect: [0, 0, 100, 100], content: { comp_id: 10 } },
    ]);
    const { problems } = buildLayoutPlan(args, facts());
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toMatch(/name is used twice/);
    expect(problems.join("\n")).toMatch(/Holder.*contains it/);
    expect(problems.join("\n")).toMatch(/pixel aspect 0.9/);
    expect(problems.join("\n")).toMatch(/smaller than 1 px/);
    expect(problems.join("\n")).toMatch(/Tpl.*contains it/);
  });

  it("refuses an existing layer that is locked, keyed, 3D, parented, a camera, or has no source size", () => {
    const one = (over: object) => buildLayoutPlan(spec([{ name: "S", rect: [0, 0, 100, 100], content: { layer: { name: "Slot" } } }]), facts({ layers: [layerFact("region:0:layer", over)] })).problems;
    expect(one({})).toEqual([]);
    expect(one({ locked: true })).toEqual(['Region "S": layer "Slot" is locked.']);
    expect(one({ keyed: 2 })[0]).toMatch(/keyframes/);
    expect(one({ three_d: true })[0]).toMatch(/3D/);
    expect(one({ parent: 3 })[0]).toMatch(/parented/);
    expect(one({ kind: "camera" })[0]).toMatch(/camera or light/);
    expect(one({ source_width: undefined, source_height: undefined })[0]).toMatch(/no source size/);
    expect(one({ found: false })[0]).toMatch(/not in the target comp/);
    expect(one({ ambiguous: true })[0]).toMatch(/fits several/);
    expect(one({ source_pixel_aspect: 0.9 })[0]).toMatch(/pixel aspect 0.9/);
  });

  it("refuses a copy of a layer with effects, a missing comp, and the same comp twice, and keeps going", () => {
    const args = parse({ comp_id: 10, copies: [{ from: { comp_id: 30, layer: { name: "Cam" } }, to_comp_id: 10 }, { from: { comp_id: 30, layer: { name: "Cam" } }, to_comp_id: 30 }, { from: { comp_id: 99, layer: { name: "Cam" } }, to_comp_id: 10 }] });
    const f = facts({ layers: [layerFact("copy:0:layer", { comp_id: 30, name: "Cam", kind: "camera", effects: 2 }), layerFact("copy:1:layer", { comp_id: 30, name: "Cam", kind: "camera" }), { key: "copy:2:layer", comp_id: 99, found: false }] });
    const { problems } = buildLayoutPlan(args, f);
    expect(problems.join("\n")).toMatch(/has effects.*crashed/);
    expect(problems.join("\n")).toMatch(/same comp/);
    expect(problems.join("\n")).toMatch(/source comp 99 does not exist/);
  });

  it("a camera copy is planned as active by default", () => {
    const args = parse({ comp_id: 10, copies: [{ from: { comp_id: 30, layer: { name: "Cam" } }, to_comp_id: 10, name: "Shot cam" }] });
    const { problems, plan } = buildLayoutPlan(args, facts({ layers: [layerFact("copy:0:layer", { comp_id: 30, name: "Cam", kind: "camera" })] }));
    expect(problems).toEqual([]);
    expect(plan.copies[0]).toMatchObject({ camera: true, as_active_camera: true, name: "Shot cam", to_comp_id: 10 });
  });

  it("create_master cannot take a template, an existing layer or stacking", () => {
    const args = parse({
      create_master: master,
      regions: [
        { name: "A", from: { layer: { name: "S" }, use: "bounds" }, content: { comp_id: 21 } },
        { name: "B", rect: [0, 0, 10, 10], content: { layer: { name: "Slot" } } },
        { name: "C", rect: [0, 0, 10, 10], content: { comp_id: 21 }, above: { name: "A" } },
      ],
    });
    const { problems } = buildLayoutPlan(args, facts({ target: null }));
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join("\n")).toMatch(/needs comp_id, not create_master/);
  });

  it("reads a rectangle from a template by mask name, a unique part of it, or index, and says why it can't", () => {
    const rows: any = [
      { index: 1, id: 5, name: "Screen", layout: { rect: [100, 50, 640, 360], masks: [{ name: "Left half", vertices: 4, rect: [100, 50, 320, 360] }, { name: "Right half", vertices: 4, rect: [420, 50, 320, 360], rect_approx: true }, { name: "Empty", vertices: 0, rect: null }] } },
      { index: 2, id: 6, name: "Cam", layout: { rect: null, rect_reason: "camera", masks: [] } },
      { index: 3, id: 7, name: "Dup", layout: { rect: [0, 0, 1, 1], masks: [] } },
      { index: 4, id: 8, name: "Dup", layout: { rect: [0, 0, 1, 1], masks: [] } },
    ];
    const src = (v: object) => ({ layer: { name: "Screen" }, use: "mask" as const, ...v });
    expect(rectFromTemplate(rows, src({ mask: "Left half" })).rect).toEqual([100, 50, 320, 360]);
    expect(rectFromTemplate(rows, src({ mask: "right" })).rect).toEqual([420, 50, 320, 360]);
    expect(rectFromTemplate(rows, src({ mask: "right" })).approx).toBe(true);
    expect(rectFromTemplate(rows, src({ mask: 2 })).rect).toEqual([420, 50, 320, 360]);
    expect(rectFromTemplate(rows, src({ mask: "half" })).problem).toMatch(/2 masks.*contain/);
    expect(rectFromTemplate(rows, src({ mask: "Empty" })).problem).toMatch(/no vertices/);
    expect(rectFromTemplate(rows, src({ mask: "Nope" })).problem).toMatch(/no mask/);
    expect(rectFromTemplate(rows, src({})).problem).toMatch(/needs mask/);
    expect(rectFromTemplate(rows, { layer: { name: "Cam" }, use: "bounds" }).problem).toMatch(/camera/);
    expect(rectFromTemplate(rows, { layer: { name: "Dup" }, use: "bounds" }).problem).toMatch(/2 layers are named/);
    expect(rectFromTemplate(rows, { layer: { id: 5 }, use: "bounds" }).rect).toEqual([100, 50, 640, 360]);
    expect(rectFromTemplate(rows, { layer: { name: "Missing" }, use: "bounds" }).problem).toMatch(/no layer named/);
  });
});

// ---------- the host, driven through the plan ----------

function apply(s: Stage, args: LayoutApplyArgs) {
  const { problems, plan } = planFor(s, args);
  expect(problems).toEqual([]);
  const written = clean(s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD }));
  return { plan, written };
}

function readComps(s: Stage, ids: number[]): any {
  return clean(s.A.layoutRead({ comp_ids: ids }));
}

describe("placement.jsx: layoutApply", () => {
  it("builds a master with fitted regions, feed comps, clip masks and camera copies in ONE undo group", () => {
    const s = stage();
    const args = bigSpec(s);
    const { plan, written } = apply(s, args);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    expect(written.created.map((c: any) => [c.role, c.name])).toEqual([["master", "T Master"], ["feed", "Feed Left"], ["feed", "Feed Right"]]);

    // A second call reads it back.
    const back = readComps(s, [...new Set<number>([written.comp_id, ...written.created.map((c: any) => c.id), s.destA.id, s.destB.id])]);
    const masterBack = back.comps[0];
    expect(masterBack).toMatchObject({ name: "T Master", width: 1920, height: 1080, num_layers: 4 });
    for (const p of written.placed) {
      const planned = plan.regions.find((r) => r.name === p.name)!;
      const layer = masterBack.layers.find((l: any) => l.id === p.layer_id);
      expect(layer.name).toBe(p.name);
      expect(layer.rect).toEqual(planned.layer_rect);
    }
    // Later regions stack above earlier ones.
    expect(masterBack.layers.map((l: any) => l.name)).toEqual(["Right feed", "Left feed", "Floor", "Wall"]);

    // Fill clips, contain does not.
    const masterComp = s.project.itemByID(written.comp_id) as FakeComp;
    const masksOf = (name: string) => (masterComp.layer(name)!.property("ADBE Mask Parade") as any);
    expect(masksOf("Wall").numProperties).toBe(1);
    expect(masksOf("Wall").property(1).name).toBe("Wall region");
    expect((masksOf("Wall").property(1).property("ADBE Mask Shape").value as Shape).vertices).toEqual([[0, 0], [640, 0], [640, 360], [0, 360]]);
    expect(masksOf("Floor").numProperties).toBe(0);
    expect(masksOf("Left feed").numProperties).toBe(1);

    // Feed comps hold exactly the fitted footage.
    const feeds = back.comps.slice(1, 3);
    expect(feeds.map((f: any) => [f.name, f.width, f.height, f.num_layers])).toEqual([["Feed Left", 480, 540, 1], ["Feed Right", 480, 540, 1]]);
    expect(feeds[0].layers[0].rect).toEqual([-240, 0, 960, 540]);
    expect(feeds[1].layers[0].rect).toEqual([0, 135, 480, 270]);

    // Copies: one new camera layer on top of each destination, renamed when asked.
    expect(written.copies).toHaveLength(2);
    const destA = back.comps.find((c: any) => c.id === s.destA.id);
    const destB = back.comps.find((c: any) => c.id === s.destB.id);
    expect(destA.layers.map((l: any) => [l.name, l.camera])).toEqual([["Camera 1", true]]);
    expect(destB.layers.map((l: any) => [l.name, l.camera])).toEqual([["Cam B", true]]);
    expect(written.copies.every((c: any) => c.camera && c.active_camera)).toBe(true);
  });

  it("stacks above and below a layer of an existing template, and fills an existing layer in place", () => {
    const s = stage();
    const slot = s.destA.layers.addSolid([1, 0, 0], "Slot", 640, 360, 1) as FakeLayer;
    const top = s.destA.layers.addSolid([0, 1, 0], "Top", 100, 100, 1) as FakeLayer;
    const bottom = s.destA.layers.addSolid([0, 0, 1], "Bottom", 100, 100, 1) as FakeLayer;
    const args = parse({
      comp_id: s.destA.id,
      regions: [
        { name: "Screen 1", rect: [100, 100, 320, 180], content: { layer: { id: slot.id } } },
        { name: "Above top", rect: [0, 0, 50, 50], content: { comp_id: s.c1.id }, above: { id: top.id } },
        { name: "Under slot", rect: [0, 0, 50, 50], content: { footage_id: s.f2.id }, below: { id: slot.id } },
      ],
    });
    const { written } = apply(s, args);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    const names = s.destA.stack.map((l) => l.name);
    expect(names.indexOf("Above top")).toBe(names.indexOf("Top") - 1);
    expect(names.indexOf("Under slot")).toBe(names.indexOf("Screen 1") + 1);
    // The existing layer was renamed, scaled to half and moved, not duplicated.
    expect(s.destA.stack.filter((l) => l.name === "Screen 1")).toHaveLength(1);
    expect(slot.name).toBe("Screen 1");
    expect(slot.transform("Scale").value.slice(0, 2)).toEqual([50, 50]);
    expect(slot.transform("Position").value.slice(0, 2)).toEqual([260, 190]);
    expect(written.placed.map((p: any) => p.name)).toEqual(["Screen 1", "Above top", "Under slot"]);
    expect(bottom.enabled).toBe(true);
  });

  it("fills regions taken from a template's masks", () => {
    const s = stage();
    const screen = s.destA.layers.addSolid([0.2, 0.2, 0.2], "Screen A", 640, 360, 1) as FakeLayer;
    screen.transform("Position").setValue([100, 50, 0]);
    screen.transform("Anchor Point").setValue([0, 0, 0]);
    const parade = screen.property("ADBE Mask Parade") as any;
    const mask = parade.addProperty("ADBE Mask Atom");
    mask.name = "Left half";
    mask.maskMode = MaskMode.ADD;
    const sh = new Shape();
    sh.vertices = [[0, 0], [320, 0], [320, 360], [0, 360]];
    sh.inTangents = sh.vertices.map(() => [0, 0]);
    sh.outTangents = sh.vertices.map(() => [0, 0]);
    mask.property("ADBE Mask Shape").setValue(sh);
    const args = parse({ comp_id: s.destA.id, regions: [{ name: "Into left", from: { layer: { name: "Screen A" }, use: "mask", mask: "Left half" }, content: { comp_id: s.c1.id } }] });
    const { plan } = apply(s, args);
    expect(plan.regions[0].rect).toEqual([100, 50, 320, 360]);
    expect(plan.regions[0].rect_from).toMatch(/mask "Left half"/);
    expect(plan.regions[0].placement.scale).toEqual([100, 100]);
    const placed = s.destA.layer("Into left")!;
    expect(placed.transform("Position").value.slice(0, 2)).toEqual([260, 230]);
  });

  it("takes out what it made and closes the group when a step throws", () => {
    const s = stage();
    const start = s.project.numItems;
    const orig = s.project.items.addComp;
    let calls = 0;
    s.project.items.addComp = (...a: Parameters<typeof orig>) => {
      if (++calls === 2) throw new Error("forced failure in the feed comp");
      return orig(...a);
    };
    const args = bigSpec(s);
    const { problems, plan } = planFor(s, args);
    expect(problems).toEqual([]);
    let err: any;
    try {
      s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD });
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/forced failure in the feed comp.*rolled back/);
    expect(err.__kind).toBe("runtime");
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    expect(s.project.numItems).toBe(start);
    // The destinations were not touched: the copies come after the regions.
    expect(s.destA.stack).toHaveLength(0);
  });

  it("puts an existing layer back as it was when a later step throws", () => {
    const s = stage();
    const slot = s.destA.layers.addSolid([1, 0, 0], "Slot", 640, 360, 1) as FakeLayer;
    slot.transform("Position").setValue([11, 22, 0]);
    const args = parse({
      comp_id: s.destA.id,
      regions: [
        { name: "Screen 1", rect: [100, 100, 320, 180], content: { layer: { id: slot.id } } },
        { name: "Fails", rect: [0, 0, 50, 50], content: { comp_id: s.c1.id } },
      ],
    });
    const { problems, plan } = planFor(s, args);
    expect(problems).toEqual([]);
    const proto = FakeLayer.prototype as any;
    const origMove = s.destA.layers.add;
    s.destA.layers.add = () => {
      throw new Error("forced failure on add");
    };
    expect(() => s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD })).toThrow(/forced failure on add/);
    s.destA.layers.add = origMove;
    expect(proto).toBeDefined();
    expect(slot.name).toBe("Slot");
    expect(slot.transform("Position").value.slice(0, 2)).toEqual([11, 22]);
    expect(slot.transform("Scale").value.slice(0, 2)).toEqual([100, 100]);
    expect(s.destA.stack).toHaveLength(1);
  });

  it("re-resolves layers and mask groups by id: references that go stale after an add are never used again", () => {
    const s = stage();
    const proto = FakeLayer.prototype as any;
    const origProperty = proto.property;
    proto.property = function (sel: string | number) {
      const r = origProperty.call(this, sel);
      if (sel === "ADBE Mask Parade" && r && !r.__strict) {
        r.__strict = true;
        const add = r.addProperty.bind(r);
        // AE: after addProperty, a held reference to the group is no longer valid.
        r.addProperty = (m: string) => {
          const made = add(m);
          r.stale = true;
          return made;
        };
      }
      return r;
    };
    const origAddComp = s.project.items.addComp;
    s.project.items.addComp = (...a: Parameters<typeof origAddComp>) => {
      const comp = origAddComp(...a) as FakeComp;
      killOnNextAdd(comp);
      return comp;
    };
    killOnNextAdd(s.destA);
    try {
      const args = bigSpec(s);
      const { written } = apply(s, args);
      expect(written.placed).toHaveLength(4);
      const wall = (s.project.itemByID(written.comp_id) as FakeComp).layer("Wall")!;
      expect((wall.property("ADBE Mask Parade") as any).numProperties).toBe(1);
      // Every clipped layer holds its one mask and nothing stray.
      const masterComp = s.project.itemByID(written.comp_id) as FakeComp;
      for (const name of ["Wall", "Left feed", "Right feed"]) {
        const parade = masterComp.layer(name)!.property("ADBE Mask Parade") as any;
        expect(parade.numProperties).toBe(name === "Right feed" ? 1 : 1);
        expect(parade.property(1).name).toBe(`${name} region`);
      }
      expect((masterComp.layer("Floor")!.property("ADBE Mask Parade") as any).numProperties).toBe(0);
    } finally {
      proto.property = origProperty;
    }
  });

  it("refuses before the undo group when the project changed since the plan: nothing is written", () => {
    const refused = (mutate: (s: Stage, slot: FakeLayer) => void, text: RegExp) => {
      const s = stage();
      const slot = s.destA.layers.addSolid([1, 0, 0], "Slot", 640, 360, 1) as FakeLayer;
      const args = parse({
        comp_id: s.destA.id,
        regions: [
          { name: "Screen 1", rect: [100, 100, 320, 180], content: { layer: { id: slot.id } } },
          { name: "Plate", rect: [0, 0, 50, 50], content: { footage_id: s.f2.id } },
        ],
      });
      const { problems, plan } = planFor(s, args);
      expect(problems).toEqual([]);
      mutate(s, slot);
      const start = s.project.numItems;
      const stackLen = s.destA.stack.length;
      const out = clean(s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD }));
      expect(out.refused).toBe(true);
      expect(out.no_op).toBe(true);
      expect(out.problems.join("\n")).toMatch(text);
      expect(s.undo.begun).toBe(0);
      expect(s.project.numItems).toBe(start);
      expect(s.destA.stack).toHaveLength(stackLen);
    };
    refused((_s, slot) => (slot.locked = true), /locked/);
    refused((_s, slot) => slot.transform("Position").setValueAtTime(0, [1, 2, 0]), /keyframes/);
    refused((_s, slot) => (slot.threeDLayer = true), /3D/);
    refused((s, slot) => (slot.parent = s.destA.layers.addNull() as FakeLayer), /parented/);
    refused((s) => ((s.f2 as any).width = 640), /changed size/);
    refused((s) => ((s.f2 as any).pixelAspect = 0.9), /pixel aspect/);
    refused((s) => s.f2.remove(), /does not exist/);
  });

  it("refuses a comp that would contain the target, in the plan and again in the host", () => {
    const s = stage();
    // Tpl B holds Tpl A as a layer.
    s.destB.layers.add(s.destA);
    const args = parse({ comp_id: s.destA.id, regions: [{ name: "Loop", rect: [0, 0, 50, 50], content: { comp_id: s.destB.id } }, { name: "Self", rect: [0, 0, 50, 50], content: { comp_id: s.destA.id } }] });
    const { problems, plan } = planFor(s, args);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/Tpl B.*contains it/);
    expect(problems.join("\n")).toMatch(/Tpl A.*contains it/);
    // The host checks the same again, in case the project changed between the plan and the write.
    const fine = parse({ comp_id: s.destA.id, regions: [{ name: "Ok", rect: [0, 0, 50, 50], content: { comp_id: s.c1.id } }] });
    const okPlan = planFor(s, fine).plan;
    const hostArgs = hostPlan(fine, okPlan);
    (hostArgs.regions[0].content as any).item_id = s.destB.id;
    (hostArgs.regions[0].content as any).size = [1920, 1080];
    const out = clean(s.A.layoutApply({ ...hostArgs, expect: GUARD }));
    expect(out.refused).toBe(true);
    expect(out.problems.join("\n")).toMatch(/would contain itself/);
    expect(s.undo.begun).toBe(0);
    expect(plan.regions.length).toBe(2);
  });

  it("refuses a copy of a layer with effects and does nothing", () => {
    const s = stage();
    (s.camera.property("ADBE Effect Parade") as any).addProperty("ADBE Fill");
    const args = parse({ comp_id: s.destA.id, copies: [{ from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destA.id }] });
    const { problems } = planFor(s, args);
    expect(problems.join("\n")).toMatch(/has effects/);
    expect(s.undo.begun).toBe(0);
  });

  it("refuses a bad guard before anything", () => {
    const s = stage();
    const args = bigSpec(s);
    const { plan } = planFor(s, args);
    expect(() => s.A.layoutApply({ ...hostPlan(args, plan), expect: { project_path: "C:/other.aep" } })).toThrow(/guard/i);
    expect(s.undo.begun).toBe(0);
  });
});

function killOnNextAdd(comp: FakeComp) {
  const add = comp.layers.add;
  let kill: (() => void) | null = null;
  comp.layers.add = (...a: any[]) => {
    kill?.();
    const real = add(...a);
    let dead = false;
    kill = () => {
      dead = true;
    };
    // AE: the layer object returned by add is only good until the comp changes again.
    return new Proxy(real, {
      get(t, k) {
        if (dead) throw new Error("Object is invalid");
        return Reflect.get(t, k, t);
      },
      set(t, k, v) {
        if (dead) throw new Error("Object is invalid");
        return Reflect.set(t, k, v, t);
      },
    });
  };
}

// ---------- the read-back check (pure) ----------

describe("layoutMismatches", () => {
  const args = parse({ comp_id: 10, regions: [{ name: "A", rect: [0, 0, 100, 100], content: { comp_id: 21 } }] });
  const { plan } = buildLayoutPlan(args, facts());
  const comp = (layers: any[], extra: object = {}) => ({ id: 10, found: true, num_layers: layers.length, layers, ...extra });
  const layer = (over: object = {}) => ({ id: 1, index: 1, name: "A", enabled: true, camera: false, rect: plan.regions[0].layer_rect, ...over });
  const other = { id: 2, index: 2, name: "Other", enabled: true, camera: false, rect: [5, 5, 10, 10] };
  const written = { comp_id: 10, placed: [{ name: "A", layer_id: 1, clip: true }], created: [], copies: [] };

  it("accepts a placement that covers the planned box, within half a pixel", () => {
    const before = { comps: [comp([other])] };
    expect(layoutMismatches(plan, args, before, { comps: [comp([layer(), other])] }, written)).toEqual([]);
    expect(layoutMismatches(plan, args, before, { comps: [comp([layer({ rect: plan.regions[0].layer_rect.map((v, i) => v + [0.4, -0.4, 0.3, 0][i]) }), other])] }, written)).toEqual([]);
  });

  it("flags a wrong box, a wrong name, a missing layer, and a layer the call did not name that moved", () => {
    const before = { comps: [comp([other])] };
    const m = layoutMismatches(plan, args, before, { comps: [comp([layer({ rect: [0, 0, 120, 100], name: "B" }), { ...other, rect: [9, 5, 10, 10] }])] }, written);
    expect(m.map((x) => x.path)).toEqual(["placed[A].name", "placed[A].rect", "layers[2].rect"]);
    const gone = layoutMismatches(plan, args, before, { comps: [comp([])] }, written);
    expect(gone.map((x) => x.path)).toEqual(["placed[A]", "layers[2]"]);
  });

  it("checks a created feed comp's size and layers, and each copy's kind and camera numbers", () => {
    const camPlan = { ...plan, copies: [{ from_comp_id: 30, from_layer_id: 7, to_comp_id: 40, camera: true, as_active_camera: true }], regions: [] };
    const srcCam = { id: 7, index: 1, name: "Camera 1", enabled: true, camera: true, rect: null, camera_facts: { zoom: 1500, position: [960, 540, -1500] } };
    const before = { comps: [{ id: 30, found: true, num_layers: 1, layers: [srcCam] }, { id: 40, found: true, num_layers: 0, layers: [] }] };
    const wcopy = { comp_id: 10, placed: [], created: [], copies: [{ to_comp_id: 40, from_layer_id: 7, layer_id: 70, camera: true }] };
    const argsCopy = parse({ comp_id: 10, copies: [{ from: { comp_id: 30, layer: { id: 7 } }, to_comp_id: 40 }] });
    const good = { comps: [comp([]), { id: 40, found: true, num_layers: 1, layers: [{ ...srcCam, id: 70 }] }] };
    expect(layoutMismatches(camPlan, argsCopy, before, good, wcopy)).toEqual([]);
    const bad = { comps: [comp([]), { id: 40, found: true, num_layers: 1, layers: [{ ...srcCam, id: 70, camera_facts: { zoom: 1000, position: [960, 540, -1500] } }] }] };
    expect(layoutMismatches(camPlan, argsCopy, before, bad, wcopy).map((x) => x.path)).toEqual(["copies[70].zoom"]);
    const notCam = { comps: [comp([]), { id: 40, found: true, num_layers: 1, layers: [{ ...srcCam, id: 70, camera: false }] }] };
    expect(layoutMismatches(camPlan, argsCopy, before, notCam, wcopy).map((x) => x.path)).toContain("copies[70].camera");
    const twice = { comps: [comp([]), { id: 40, found: true, num_layers: 3, layers: [{ ...srcCam, id: 70 }] }] };
    expect(layoutMismatches(camPlan, argsCopy, before, twice, wcopy).map((x) => x.path)).toContain("comp[40].num_layers");

    const feedArgs = parse({ comp_id: 10, regions: [{ name: "F", rect: [0, 0, 480, 540], content: { footage_id: 20, make_feed: { name: "Feed" } } }] });
    const feedPlan = buildLayoutPlan(feedArgs, facts()).plan;
    const wf = { comp_id: 10, placed: [], created: [{ kind: "comp", role: "feed", id: 50, name: "Feed" }], copies: [] };
    const wrong = { comps: [comp([]), { id: 50, found: true, width: 100, height: 100, num_layers: 2, layers: [] }] };
    expect(layoutMismatches(feedPlan, feedArgs, { comps: [comp([])] }, wrong, wf).map((x) => x.path)).toEqual(["created[Feed].size", "created[Feed].num_layers"]);
    const absent = { comps: [comp([]), { id: 50, found: false, layers: [] }] };
    expect(layoutMismatches(feedPlan, feedArgs, { comps: [comp([])] }, absent, wf).map((x) => x.path)).toEqual(["created[Feed]"]);
  });
});

// ---------- the tool end to end (real host code behind a bridge) ----------

function e2e(s: Stage) {
  const calls: Array<{ fn: string; args: any; timeout?: number }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-placement-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      try {
        return { ok: true, result: clean(s.A[fn](args)), durationMs: 1 };
      } catch (e) {
        return { ok: false, error: s.A.formatError(e), durationMs: 1 };
      }
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir };
  return { ctx, calls };
}

describe("ae_layout_apply tool", () => {
  it("plans, writes in one group, reads back separately, and the receipt matches", async () => {
    const s = stage();
    const { ctx, calls } = e2e(s);
    const out: any = await tool.handler(bigSpec(s), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.receipt.mismatches).toEqual([]);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    // Guard, facts, guard, before read, write, after read.
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "layoutFacts", "checkGuard", "layoutRead", "layoutApply", "layoutRead"]);
    expect(out.placed).toHaveLength(4);
    expect(out.placed[0]).toMatchObject({ name: "Wall", rect: [0, 0, 960, 540], scale: [150, 150] });
    expect(out.created).toHaveLength(3);
    expect(out.copies).toHaveLength(2);
    // The camera copy is honest about being unmeasured.
    expect(out.camera_copy.verified).toBe(false);
    expect(out.camera_copy.note).toMatch(/not been measured/);
    // The after read asks for the new comps too.
    expect(calls[5].args.comp_ids).toEqual(expect.arrayContaining(out.created.map((c: any) => c.id)));
  });

  it("above 20 regions the receipt's reads keep only the layers with a mismatch, and the warnings are capped", async () => {
    const s = stage();
    const { ctx } = e2e(s);
    const regions = Array.from({ length: 30 }, (_v, i) => ({
      name: `R${i}`,
      rect: [(i % 10) * 100, Math.floor(i / 10) * 100, 100.6, 50.2],
      content: { footage_id: s.f1.id, make_feed: { name: `Feed ${i}` } },
    }));
    const out: any = await tool.handler(parse({ create_master: master, regions }), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.placed).toHaveLength(30);
    // The reads are trimmed to the layers that have a mismatch (none here), with the count of what was read.
    expect(out.receipt.after.trimmed).toBe(true);
    const target = out.receipt.after.comps.find((c: any) => c.id === out.comp_id);
    expect(target.layers_read).toBeGreaterThanOrEqual(30);
    expect(target.layers).toEqual([]);
    expect(out.warnings.length).toBeLessThanOrEqual(20);
    expect(out.warnings_total).toBeGreaterThan(20);
  });

  it("trimLayoutReceipt keeps the layers named by a mismatch and leaves a small receipt alone", () => {
    const comp = { id: 1, found: true, layers: [{ id: 5, name: "A" }, { id: 6, name: "B" }, { id: 7, name: "C" }] };
    const result = { receipt: { before: { comps: [comp] }, after: { comps: [comp] }, mismatches: [{ path: "placed[B].rect" }, { path: "copies[7].zoom" }] } };
    const small: any = trimLayoutReceipt(clean(result), 20);
    expect(small.receipt.after.comps[0].layers).toHaveLength(3);
    const big: any = trimLayoutReceipt(clean(result), 21);
    expect(big.receipt.after.comps[0].layers.map((l: any) => l.name)).toEqual(["B", "C"]);
    expect(big.receipt.after.comps[0].layers_read).toBe(3);
  });

  it("flags a camera that copyToComp did not copy faithfully", async () => {
    const s = stage();
    const origCopy = s.camera.copyToComp.bind(s.camera);
    (s.camera as any).copyToComp = (dest: FakeComp) => {
      origCopy(dest);
      const copy = dest.stack[0];
      (copy.property("ADBE Camera Options Group") as any).property("ADBE Camera Zoom").staticValue = 999;
    };
    const { ctx } = e2e(s);
    const args = parse({ comp_id: s.destA.id, copies: [{ from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destA.id }] });
    const out: any = await tool.handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(out.camera_copy.verified).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain(`copies[${out.copies[0].layer_id}].zoom`);
  });

  it("a dry run caps the plan's warnings too, with the count", async () => {
    const s = stage();
    const { ctx } = e2e(s);
    const regions = Array.from({ length: 30 }, (_v, i) => ({
      name: `R${i}`,
      rect: [(i % 10) * 100, Math.floor(i / 10) * 100, 100.6, 50.2],
      content: { footage_id: s.f1.id, make_feed: { name: `Feed ${i}` } },
    }));
    const out: any = await tool.handler(parse({ create_master: master, regions, dry_run: true }), ctx);
    expect(out.dry_run).toBe(true);
    expect(out.plan.warnings.length).toBeLessThanOrEqual(20);
    expect(out.plan.warnings_total).toBeGreaterThan(20);
  });

  it("a dry run returns the plan and sends no write, no guard check and no read-back", async () => {
    const s = stage();
    const items = s.project.numItems;
    const { ctx, calls } = e2e(s);
    const out: any = await tool.handler(parse({ ...clean(bigSpec(s)), dry_run: true }), ctx);
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["layoutFacts"]);
    expect(out.plan.regions).toHaveLength(4);
    expect(out.plan.regions[2]).toMatchObject({ name: "Left feed", creates: { comp: "Feed Left", size: [480, 540] } });
    expect(out.plan.copies[0]).toMatchObject({ camera: true, as_active_camera: true });
    expect(s.undo.begun).toBe(0);
    expect(s.project.numItems).toBe(items);
  });

  it("refuses with every problem listed and writes nothing", async () => {
    const s = stage();
    const { ctx, calls } = e2e(s);
    const args = parse({
      comp_id: s.destA.id,
      regions: [
        { name: "Dup", rect: [0, 0, 100, 100], content: { comp_id: s.c1.id } },
        { name: "Dup", rect: [0, 0, 100, 100], content: { comp_id: s.destA.id } },
        { name: "Tiny", rect: [0, 0, 0.2, 100], content: { footage_id: s.f1.id } },
      ],
    });
    const out: any = await tool.handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "layout_rejected", applied: false, no_op: true, problems_total: 3 });
    expect(calls.map((c) => c.fn)).not.toContain("layoutApply");
    expect(s.undo.begun).toBe(0);
  });

  it("refuses a wrong project before any read of the project", async () => {
    const s = stage();
    const { ctx, calls } = e2e(s);
    await expect(tool.handler(parse({ ...clean(bigSpec(s)), expect: { project_path: "C:/other.aep" } }), ctx)).rejects.toThrow();
    expect(calls.map((c) => c.fn)).not.toContain("layoutApply");
  });

  it("uses the slow timeout above 20 regions and copies", async () => {
    const s = stage();
    const sent: Array<number | undefined> = [];
    const regions = Array.from({ length: 21 }, (_, i) => ({ name: `R${i}`, rect: [i * 10, 0, 10, 10], content: { comp_id: s.c1.id }, fit: "stretch" }));
    const { ctx } = e2e(s);
    const orig = ctx.bridge.evalRaw.bind(ctx.bridge);
    (ctx.bridge as any).evalRaw = (req: any) => {
      if (String(req.script).startsWith("__chromaAe.layoutApply")) sent.push(req.timeoutMs);
      return orig(req);
    };
    const out: any = await tool.handler(parse({ comp_id: s.destA.id, regions }), ctx);
    expect(out.applied).toBe(true);
    expect(sent).toEqual([600_000]);
    const small = await tool.handler(parse({ comp_id: s.destB.id, regions: regions.slice(0, 2) }), ctx);
    expect((small as any).applied).toBe(true);
    expect(sent).toEqual([600_000, undefined]);
  });
});

// ---------- repair round: one test per behaviour ----------

import { zodToJsonSchema } from "../src/schema.js";

const camSpec = (s: Stage, to: FakeComp, extra: object = {}) => parse({ comp_id: to.id, copies: [{ from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: to.id, ...extra }] });

describe("camera copies: what is compared, and when", () => {
  it("a faithful copy of a KEYED camera is not flagged when the two comps sit at different times", async () => {
    const s = stage();
    const pos = s.camera.transform("Position") as any;
    pos.setValueAtTime(0, [960, 540, -1500]);
    pos.setValueAtTime(2, [1200, 540, -1500]);
    s.camA.time = 0;
    s.destA.time = 2;
    const { ctx } = e2e(s);
    const out: any = await tool.handler(camSpec(s, s.destA), ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
    // The two comps really would have read different values through .value.
    expect((s.destA.stack[0].transform("Position") as any).value).not.toEqual((s.camera.transform("Position") as any).value);
    expect(out.camera_copy.note).toMatch(/value at time 0/);
    expect(out.camera_copy.note).toMatch(/NOT compared/);
  });

  it("flags a copy with another point of interest, another number of keys, or another node count", async () => {
    const bad = async (tweak: (copy: FakeLayer) => void, key: string) => {
      const s = stage();
      (s.camera.transform("Position") as any).setValueAtTime(0, [960, 540, -1500]);
      (s.camera.transform("Position") as any).setValueAtTime(2, [1000, 540, -1500]);
      const orig = s.camera.copyToComp.bind(s.camera);
      (s.camera as any).copyToComp = (dest: FakeComp) => {
        orig(dest);
        tweak(dest.stack[0]);
      };
      const { ctx } = e2e(s);
      const out: any = await tool.handler(camSpec(s, s.destA), ctx);
      expect(out.receipt.matches).toBe(false);
      expect(out.receipt.mismatches.map((m: any) => m.path.replace(/\d+/, "N"))).toContain(key);
    };
    await bad((c) => c.transform("Anchor Point").setValue([1, 2, 3]), "copies[N].point_of_interest");
    await bad((c) => ((c.transform("Position") as any).keys = []), "copies[N].keys.position");
    await bad((c) => ((c as any).autoOrient = AutoOrientType.NO_AUTO_ORIENT), "copies[N].two_node");
  });

  it("as_active_camera moves the copy to the top, also when copyToComp put it elsewhere", () => {
    const s = stage();
    const old = s.destA.layers.addCamera("Old cam", [0, 0]) as FakeLayer;
    const orig = s.camera.copyToComp.bind(s.camera);
    (s.camera as any).copyToComp = (dest: FakeComp) => {
      orig(dest);
      dest.stack.push(dest.stack.shift() as FakeLayer);
    };
    const args = camSpec(s, s.destA);
    const { written } = apply(s, args);
    expect(s.destA.stack.map((l) => l.name)).toEqual(["Camera 1", "Old cam"]);
    expect(written.copies[0].active_camera).toBe(true);
    expect(old.index).toBe(2);
  });

  it("as_active_camera: false keeps the camera that was active", () => {
    const s = stage();
    s.destA.layers.addCamera("Old cam", [0, 0]);
    const args = camSpec(s, s.destA, { as_active_camera: false });
    const { written } = apply(s, args);
    expect(s.destA.stack.map((l) => l.name)).toEqual(["Old cam", "Camera 1"]);
    expect(written.copies[0].active_camera).toBe(false);
  });

  it("stops and takes everything out when copyToComp adds two layers, or none", () => {
    for (const extra of [2, 0]) {
      const s = stage();
      const orig = s.camera.copyToComp.bind(s.camera);
      (s.camera as any).copyToComp = (dest: FakeComp) => {
        for (let i = 0; i < extra; i++) orig(dest);
      };
      const args = parse({
        comp_id: s.destA.id,
        regions: [{ name: "R", rect: [0, 0, 50, 50], content: { comp_id: s.c1.id } }],
        copies: [{ from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destB.id }],
      });
      const { problems, plan } = planFor(s, args);
      expect(problems).toEqual([]);
      expect(() => s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD })).toThrow(new RegExp(`could not tell which layer copyToComp added.*\\(${extra} new layers\\)`));
      expect(s.destA.stack).toHaveLength(0);
      expect(s.destB.stack).toHaveLength(0);
      expect(s.undo).toEqual({ begun: 1, ended: 1 });
    }
  });

  it("refuses a copy whose layer gained effects after the plan (the host checks again)", () => {
    const s = stage();
    const args = camSpec(s, s.destA);
    const { problems, plan } = planFor(s, args);
    expect(problems).toEqual([]);
    (s.camera.property("ADBE Effect Parade") as any).addProperty("ADBE Fill");
    const out = clean(s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD }));
    expect(out.refused).toBe(true);
    expect(out.problems.join("\n")).toMatch(/has effects/);
    expect(s.undo.begun).toBe(0);
    expect(s.destA.stack).toHaveLength(0);
  });

  it("warns that a parented layer is copied without its parent", () => {
    const args = parse({ comp_id: 10, copies: [{ from: { comp_id: 30, layer: { name: "Cam" } }, to_comp_id: 10 }] });
    const f = facts({ layers: [layerFact("copy:0:layer", { comp_id: 30, name: "Cam", kind: "camera", parent: 3 })] });
    const { problems, plan } = buildLayoutPlan(args, f);
    expect(problems).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/does not carry the parent link/);
  });
});

describe("filling an existing layer", () => {
  function slotStage() {
    const s = stage();
    const a = s.destA.layers.addSolid([0, 1, 0], "A", 100, 100, 1) as FakeLayer;
    const slot = s.destA.layers.addSolid([1, 0, 0], "Slot", 640, 360, 1) as FakeLayer;
    const b = s.destA.layers.addSolid([0, 0, 1], "B", 100, 100, 1) as FakeLayer;
    // Order top to bottom: B, Slot, A (addSolid puts each new layer on top).
    return { ...s, a, slot, b };
  }
  const fill = (s: ReturnType<typeof slotStage>, extra: object = {}, name = "Screen") => parse({ comp_id: s.destA.id, regions: [{ name, rect: [100, 100, 320, 180], content: { layer: { id: s.slot.id } }, ...extra }] });

  it("resets rotation to 0, drops a flip, and says both in warnings (plan and result)", () => {
    const s = slotStage();
    s.slot.transform("Rotation").setValue(30);
    s.slot.transform("Scale").setValue([-100, 100, 100]);
    const args = fill(s);
    const { problems, plan } = planFor(s, args);
    expect(problems).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/rotated 30 degrees/);
    expect(plan.warnings.join(" ")).toMatch(/flipped/);
    const written = clean(s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD }));
    expect(s.slot.transform("Rotation").value).toBe(0);
    expect(s.slot.transform("Scale").value.slice(0, 2)).toEqual([50, 50]);
    expect(written.warnings.join(" ")).toMatch(/rotated 30 degrees; the placement sets rotation to 0/);
    expect(written.warnings.join(" ")).toMatch(/flipped \(negative scale\)/);
  });

  it("refuses a layer that is a parent, one with Position separated, one filled twice - in the plan and again in the host", () => {
    // Plan level, from the host's own facts.
    const parentStage = slotStage();
    const child = parentStage.destA.layers.addSolid([1, 1, 1], "Child", 10, 10, 1) as FakeLayer;
    child.parent = parentStage.slot;
    expect(planFor(parentStage, fill(parentStage)).problems.join("\n")).toMatch(/parent of other layers/);
    const sepStage = slotStage();
    sepStage.slot.separatePosition();
    expect(planFor(sepStage, fill(sepStage)).problems.join("\n")).toMatch(/Position separated/);
    const dupStage = slotStage();
    const dup = parse({
      comp_id: dupStage.destA.id,
      regions: [
        { name: "One", rect: [0, 0, 50, 50], content: { layer: { id: dupStage.slot.id } } },
        { name: "Two", rect: [60, 0, 50, 50], content: { layer: { name: "Slot" } } },
      ],
    });
    expect(planFor(dupStage, dup).problems.join("\n")).toMatch(/already filled by another region/);

    // Host level: the project changes between the plan and the write.
    const hostCases: Array<[string, (s: ReturnType<typeof slotStage>) => void, RegExp]> = [
      ["parent", (s) => ((s.destA.layers.addSolid([1, 1, 1], "Kid", 10, 10, 1) as FakeLayer).parent = s.slot), /parent of other layers/],
      ["separated", (s) => s.slot.separatePosition(), /Position separated/],
    ];
    for (const [, mutate, text] of hostCases) {
      const s = slotStage();
      const args = fill(s);
      const { problems, plan } = planFor(s, args);
      expect(problems).toEqual([]);
      mutate(s);
      const out = clean(s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD }));
      expect(out.refused).toBe(true);
      expect(out.problems.join("\n")).toMatch(text);
      expect(s.undo.begun).toBe(0);
    }
    // Two regions on one layer, handed to the host straight.
    const s = slotStage();
    const one = fill(s);
    const plan = planFor(s, one).plan;
    const hp = hostPlan(one, plan);
    const twin = { ...hp, regions: [hp.regions[0], { ...hp.regions[0], name: "Twin" }] };
    const out = clean(s.A.layoutApply({ ...twin, expect: GUARD }));
    expect(out.refused).toBe(true);
    expect(out.problems.join("\n")).toMatch(/already filled by another region/);
  });

  it("a keyed Position_0 on a separated layer is counted as keyframes", () => {
    const s = slotStage();
    s.slot.separatePosition();
    (s.slot.transform("Position") as any);
    const tr = s.slot.group.property("ADBE Transform Group") as any;
    tr.property("ADBE Position_0").setValueAtTime(0, 5);
    const facts2 = clean(s.A.layoutFacts({ ...factsRequest(fill(s)), expect: GUARD }));
    expect(facts2.layers[0].keyed).toBeGreaterThan(0);
    expect(facts2.layers[0].separated).toBe(true);
  });

  it("replaces its own clip mask instead of stacking a second one, and intersects when the layer has other masks", () => {
    const s = slotStage();
    const first = fill(s);
    apply(s, first);
    const parade = () => s.slot.property("ADBE Mask Parade") as any;
    expect(parade().numProperties).toBe(1);
    expect(parade().property(1).name).toBe("Screen region");
    expect(parade().property(1).maskMode).toBe(MaskMode.ADD);
    // Again with another rectangle: still one mask, with the new corners.
    apply(s, parse({ comp_id: s.destA.id, regions: [{ name: "Screen", rect: [0, 0, 160, 90], content: { layer: { id: s.slot.id } } }] }));
    expect(parade().numProperties).toBe(1);
    expect((parade().property(1).property("ADBE Mask Shape").value as Shape).vertices[2]).toEqual([expect.any(Number), expect.any(Number)]);
    // A layer that has another mask gets an INTERSECT clip, and a second run does not add another.
    const other = parade().addProperty("ADBE Mask Atom");
    other.name = "Cutout";
    apply(s, first);
    apply(s, first);
    expect(parade().numProperties).toBe(2);
    const names = [1, 2].map((i) => parade().property(i).name);
    expect(names).toContain("Cutout");
    const clip = [1, 2].map((i) => parade().property(i)).find((m: any) => m.name === "Screen region");
    expect(clip.maskMode).toBe(MaskMode.INTERSECT);
  });

  it("a failure late in the call removes added layers and copies, restores the layer's name, place, index and mask", () => {
    const s = slotStage();
    // The layer already has a clip of the same name: it is replaced, and must come back on rollback.
    const parade = s.slot.property("ADBE Mask Parade") as any;
    const old = parade.addProperty("ADBE Mask Atom");
    old.name = "Screen region";
    old.maskMode = MaskMode.SUBTRACT;
    const oldShape = shape([[1, 2], [3, 4], [5, 6], [7, 8]]);
    old.property("ADBE Mask Shape").setValue(oldShape);
    s.slot.transform("Position").setValue([11, 22, 0]);
    const before = s.destA.stack.map((l) => [l.id, l.name]);
    const idxBefore = s.slot.index;
    const args = parse({
      comp_id: s.destA.id,
      regions: [
        { name: "New", rect: [0, 0, 40, 40], content: { comp_id: s.c1.id } },
        { name: "Screen", rect: [100, 100, 320, 180], content: { layer: { id: s.slot.id } }, below: { id: s.a.id } },
      ],
      copies: [
        { from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destB.id },
        { from: { comp_id: s.camA.id, layer: { name: "Camera 1" } }, to_comp_id: s.destB.id },
      ],
    });
    const { problems, plan } = planFor(s, args);
    expect(problems).toEqual([]);
    const orig = s.camera.copyToComp.bind(s.camera);
    let n = 0;
    (s.camera as any).copyToComp = (dest: FakeComp) => {
      if (++n === 2) throw new Error("forced failure on the second copy");
      orig(dest);
    };
    let err: any;
    try {
      s.A.layoutApply({ ...hostPlan(args, plan), expect: GUARD });
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/forced failure on the second copy \(rolled back/);
    expect(err.message).not.toMatch(/INCOMPLETE/);
    // The target is as it was: same layers in the same order, the slot back where it was with its old name, place and mask.
    expect(s.destA.stack.map((l) => [l.id, l.name])).toEqual(before);
    expect(s.slot.index).toBe(idxBefore);
    expect(s.slot.name).toBe("Slot");
    expect(s.slot.transform("Position").value.slice(0, 2)).toEqual([11, 22]);
    expect(s.slot.transform("Scale").value.slice(0, 2)).toEqual([100, 100]);
    expect(parade.numProperties).toBe(1);
    const back = (s.slot.property("ADBE Mask Parade") as any).property(1);
    expect(back.name).toBe("Screen region");
    expect(back.maskMode).toBe(MaskMode.SUBTRACT);
    expect((back.property("ADBE Mask Shape").value as Shape).vertices).toEqual(oldShape.vertices);
    // The first copy, made before the failure, is gone too.
    expect(s.destB.stack).toHaveLength(0);
  });

  it("says the rollback was incomplete when a step of it fails", () => {
    const s = slotStage();
    const args = fill(s);
    const { plan } = planFor(s, args);
    const hp = hostPlan(args, plan);
    // The clip is added, then something later throws and the rollback cannot remove the mask.
    const orig = s.slot.property.bind(s.slot);
    let broken = false;
    (s.slot as any).property = (sel: string) => {
      if (broken && sel === "ADBE Mask Parade") throw new Error("mask group is locked");
      return orig(sel);
    };
    const origMove = s.slot.moveBefore.bind(s.slot);
    void origMove;
    const add = s.destA.layers.add;
    s.destA.layers.add = add;
    const twoRegions = { ...hp, regions: [hp.regions[0]], copies: [{ from_comp_id: s.camA.id, from_layer_id: s.camera.id, to_comp_id: s.destB.id }] };
    (s.camera as any).copyToComp = () => {
      broken = true;
      throw new Error("forced failure after the clip");
    };
    let err: any;
    try {
      s.A.layoutApply({ ...twoRegions, expect: GUARD });
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/forced failure after the clip \(rollback INCOMPLETE, 1 step\(s\) failed: clip mask Screen region/);
  });
});

describe("layoutRead and layoutFacts", () => {
  it("reads every comp asked for, up to 400 (a layout can name about 300)", () => {
    const s = stage();
    const ids: number[] = [];
    for (let i = 0; i < 120; i++) ids.push((s.project.addComp(`C${i}`, 64, 64, 1) as FakeComp).id);
    const back = readComps(s, ids);
    expect(back.comps).toHaveLength(120);
    expect(back.comps.every((c: any) => c.found)).toBe(true);
  });

  it("the read-back box includes the layer's rotation", () => {
    const s = stage();
    const l = s.destA.layers.addSolid([1, 1, 1], "Turned", 200, 100, 1) as FakeLayer;
    l.transform("Position").setValue([500, 200, 0]);
    l.transform("Anchor Point").setValue([0, 0, 0]);
    l.transform("Rotation").setValue(90);
    const back = readComps(s, [s.destA.id]);
    expect(back.comps[0].layers[0].rect).toEqual([400, 200, 100, 200]);
  });

  it("the facts read refuses a wrong project: on a dry run it is the only guard", async () => {
    const s = stage();
    expect(() => s.A.layoutFacts({ ...factsRequest(bigSpec(s)), expect: { project_path: "C:/other.aep" } })).toThrow(/guard/i);
    const { ctx, calls } = e2e(s);
    await expect(tool.handler(parse({ ...clean(bigSpec(s)), dry_run: true, expect: { project_path: "C:/other.aep" } }), ctx)).rejects.toThrow();
    expect(calls.map((c) => c.fn)).toEqual(["layoutFacts"]);
    expect(s.project.numItems).toBe(6);
  });
});

describe("plan details", () => {
  it("two feed comps with one name are checked against their own sizes", async () => {
    const s = stage();
    const args = parse({
      comp_id: s.destA.id,
      regions: [
        { name: "One", rect: [0, 0, 480, 540], content: { footage_id: s.f2.id, make_feed: { name: "Feed" } } },
        { name: "Two", rect: [500, 0, 960, 270], content: { footage_id: s.f1.id, make_feed: { name: "Feed" } } },
      ],
    });
    const { ctx } = e2e(s);
    const out: any = await tool.handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.created.map((c: any) => c.name)).toEqual(["Feed", "Feed"]);
  });

  it("says how many mismatches were not listed when the list is capped", () => {
    const regions = Array.from({ length: 60 }, (_, i) => ({ name: `R${i}`, rect: [0, 0, 100, 100], content: { comp_id: 21 } }));
    const args = parse({ comp_id: 10, regions });
    const { plan } = buildLayoutPlan(args, facts());
    const placed = plan.regions.map((r, i) => ({ name: r.name, layer_id: 100 + i, clip: true }));
    const layers = plan.regions.map((r, i) => ({ id: 100 + i, index: i + 1, name: r.name, enabled: true, camera: false, rect: [9, 9, 9, 9] }));
    const m = layoutMismatches(plan, args, { comps: [{ id: 10, found: true, num_layers: 0, layers: [] }] }, { comps: [{ id: 10, found: true, num_layers: 60, layers }] }, { comp_id: 10, placed, created: [], copies: [] });
    expect(m).toHaveLength(51);
    expect(m[50]).toMatchObject({ path: "mismatches", actual: 10 });
    expect(m[50].message).toMatch(/10 more mismatch\(es\) are not listed/);
  });

  it("bounds create_master's frame rate and length like ae_create_comp", () => {
    const ok = (over: object) => AeLayoutApplySchema.safeParse({ expect: GUARD, create_master: { ...master, ...over }, regions: [{ name: "A", rect: [0, 0, 5, 5], content: { comp_id: 1 } }] }).success;
    expect(ok({})).toBe(true);
    expect(ok({ fps: 100 })).toBe(false);
    expect(ok({ fps: 0.5 })).toBe(false);
    expect(ok({ duration: 10801 })).toBe(false);
    expect(ok({ duration: 10800 })).toBe(true);
  });

  it("the host refuses a frame rate or length AE would throw on, before its group", () => {
    const s = stage();
    const args = parse({ create_master: master, regions: [{ name: "A", rect: [0, 0, 50, 50], content: { comp_id: s.c1.id } }] });
    const { plan } = planFor(s, args);
    const hp = hostPlan(args, plan);
    const bad = { ...hp, target: { create: { ...(hp.target as any).create, fps: 100, duration: 20000 } } };
    const out = clean(s.A.layoutApply({ ...bad, expect: GUARD }));
    expect(out.refused).toBe(true);
    expect(out.problems.join("\n")).toMatch(/fps must be a number in 1..99/);
    expect(out.problems.join("\n")).toMatch(/at most 10800/);
    expect(s.undo.begun).toBe(0);
  });

  it("reads a mask past the 20th when a region names it", async () => {
    const s = stage();
    const t = s.destA.layers.addSolid([1, 1, 1], "Many", 640, 360, 1) as FakeLayer;
    t.transform("Position").setValue([0, 0, 0]);
    t.transform("Anchor Point").setValue([0, 0, 0]);
    const parade = t.property("ADBE Mask Parade") as any;
    for (let i = 1; i <= 25; i++) {
      const m = parade.addProperty("ADBE Mask Atom");
      m.name = i === 25 ? "Tail" : `Filler ${i}`;
      m.property("ADBE Mask Shape").setValue(shape([[i, i], [i + 10, i], [i + 10, i + 10]]));
    }
    const { ctx } = e2e(s);
    const out: any = await tool.handler(parse({ comp_id: s.destA.id, dry_run: true, regions: [{ name: "In tail", from: { layer: { name: "Many" }, use: "mask", mask: "Tail" }, content: { comp_id: s.c1.id } }] }), ctx);
    expect(out.ok).toBe(true);
    expect(out.plan.regions[0].rect).toEqual([25, 25, 10, 10]);
  });

  it("the key names of content, rect, align and make_feed are in the published schema text", () => {
    const text = JSON.stringify(zodToJsonSchema(AeLayoutApplySchema));
    for (const part of ["[x, y, width, height]", "{comp_id} a comp to nest", "{layer} a layer already in the target comp", "make_feed:{name, width?, height?, fit?, target_folder_id?}", "0 = left / top, 1 = right / bottom", "make_feed.name is the new comp's name", "width / height its size in pixels (default: the region's size, rounded)", "fit how the footage sits inside it", "target_folder_id the project folder (item id) it goes in"]) {
      expect(text, part).toContain(part);
    }
  });

  it("names a layer found again by id, never the object add returned (that one is only good for its id)", () => {
    const s = stage();
    const origAdd = s.destA.layers.add;
    s.destA.layers.add = (...a: any[]) => {
      const real = origAdd(...a);
      return new Proxy(real, {
        get(t, k) {
          if (k !== "id") throw new Error("Object is invalid");
          return Reflect.get(t, k, t);
        },
        set() {
          throw new Error("Object is invalid");
        },
      });
    };
    const args = parse({ comp_id: s.destA.id, regions: [{ name: "Named", rect: [0, 0, 50, 50], content: { comp_id: s.c1.id } }] });
    apply(s, args);
    expect(s.destA.stack.map((l) => l.name)).toEqual(["Named"]);
  });
});

function shape(vertices: number[][]): Shape {
  const sh = new Shape();
  sh.vertices = vertices;
  sh.inTangents = vertices.map(() => [0, 0]);
  sh.outTangents = vertices.map(() => [0, 0]);
  return sh;
}
