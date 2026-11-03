/**
 * The 0.4 host functions run for real under node:vm, against the simulated
 * AE DOM in support/fake-ae.ts: layers, markers, keyframes, cue keys, rest
 * bounds, the project inventory and paged reads.
 */

import { describe, expect, it } from "vitest";
import {
  FakeProject,
  GUARD,
  KeyframeInterpolationType,
  LightType,
  loadHost,
  MarkerValue,
  TextDocument,
  TrackMatteType,
  type FakeComp,
  type FakeLayer,
  type FakeProperty,
} from "./support/fake-ae.js";

function scene(opts: { modernMattes?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  comp.modernMattes = opts.modernMattes ?? true;
  return { project, comp };
}

const names = (c: FakeComp) => c.stack.map((l) => l.name);

describe("layers.jsx", () => {
  it("creates each kind of layer, named, placed and parented", () => {
    const { project, comp } = scene();
    const { A, undo } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "BG", color: [0, 0, 0], expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "null", name: "Ctrl", placement: { bottom: true }, expect: GUARD });
    const logo = A.createLayer({ comp_id: comp.id, type: "solid", name: "Logo", width: 50, height: 50, placement: { below: { name: "BG" } }, parent: { name: "Ctrl" }, expect: GUARD });
    expect(names(comp)).toEqual(["BG", "Logo", "Ctrl"]);
    expect(logo).toMatchObject({ index: 2, name: "Logo", kind: "solid" });
    expect(comp.layer("Logo")!.parent?.name).toBe("Ctrl");
    const light = A.createLayer({ comp_id: comp.id, type: "light", name: "Key", light_type: "spot", placement: { index: 2 }, expect: GUARD });
    expect(light.index).toBe(2);
    expect(comp.layer("Key")!.lightType).toBe(LightType.SPOT);
    A.createLayer({ comp_id: comp.id, type: "adjustment", expect: GUARD });
    expect(comp.layer(1)!.adjustmentLayer).toBe(true);
    expect(comp.layer(1)!.name).toBe("Adjustment Layer");
    A.createLayer({ comp_id: comp.id, type: "text", text: "Hello", box_size: [200, 80], three_d: true, duration: 1, expect: GUARD });
    const text = comp.layer(1)!;
    expect(text.reflect.name).toBe("TextLayer");
    expect(text.threeDLayer).toBe(true);
    expect(text.outPoint).toBe(1);
    expect(undo.begun).toBe(6);
    expect(undo.ended).toBe(6);
  });

  it("adds a precomp from a comp item and refuses a comp inside itself", () => {
    const { project, comp } = scene();
    const inner = project.addComp("Inner", 320, 180, 2);
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "precomp", item_id: inner.id, expect: GUARD });
    expect(comp.layer(1)!.source).toBe(inner);
    expect(() => A.createLayer({ comp_id: comp.id, type: "precomp", item_id: comp.id, expect: GUARD })).toThrow(/can't contain itself/);
    expect(() => A.createLayer({ comp_id: comp.id, type: "footage", item_id: inner.id, expect: GUARD })).toThrow(/not footage/);
  });

  it("refuses a write when the guard doesn't match", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    expect(() => A.createLayer({ comp_id: comp.id, type: "null", expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(comp.numLayers).toBe(0);
  });

  it("reports the stack with kinds, text and track mattes", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "text", text: "MATTE", expect: GUARD });
    const s = A.layerStack({ comp_id: comp.id });
    expect(s.layers.map((l: any) => [l.index, l.kind, l.text ?? null])).toEqual([
      [1, "text", "MATTE"],
      [2, "solid", null],
    ]);
    expect(s.layers[1].trackMatte).toEqual({ type: "none", layer: null });
  });

  it("sets a matte from a layer that isn't directly above (AE 23+), hides it, and removes it", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "null", name: "Gap", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "text", text: "MATTE", expect: GUARD });
    const r = A.setTrackMatte({ comp_id: comp.id, layer: { name: "Plate" }, matte: { name: "MATTE" }, type: "luma", expect: GUARD });
    expect(r).toMatchObject({ api: "setTrackMatte", matte: { name: "MATTE" } });
    const plate = comp.layer("Plate")!;
    expect(plate.trackMatteType).toBe(TrackMatteType.LUMA);
    expect(comp.layer("MATTE")!.enabled).toBe(false);
    const s = A.layerStack({ comp_id: comp.id });
    expect(s.layers[2].trackMatte).toEqual({ type: "luma", layer: { index: 1, id: comp.layer("MATTE")!.id, name: "MATTE" } });
    expect(s.layers[0].isTrackMatte).toBe(true);
    const off = A.setTrackMatte({ comp_id: comp.id, layer: { name: "Plate" }, type: "none", show_matte: true, expect: GUARD });
    expect(off.previous_matte.name).toBe("MATTE");
    expect(plate.trackMatteLayer).toBeNull();
    expect(comp.layer("MATTE")!.enabled).toBe(true);
  });

  it("on older AE, refuses a matte that isn't the layer above instead of matting with the wrong one", () => {
    const { project, comp } = scene({ modernMattes: false });
    const { A } = loadHost(project, ["layers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "null", name: "Gap", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Mask", expect: GUARD });
    expect(() => A.setTrackMatte({ comp_id: comp.id, layer: { name: "Plate" }, matte: { name: "Mask" }, type: "alpha", expect: GUARD })).toThrow(/directly above/);
    const r = A.setTrackMatte({ comp_id: comp.id, layer: { name: "Gap" }, matte: { name: "Mask" }, type: "alpha", expect: GUARD });
    expect(r.api).toBe("legacy");
    expect(comp.layer("Gap")!.trackMatteType).toBe(TrackMatteType.ALPHA);
    expect(A.layerStack({ comp_id: comp.id }).layers[1].trackMatte.layer.name).toBe("Mask");
  });

  it("precomposes layers in order, and refuses leaving attributes for several", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx"]);
    for (const n of ["C", "B", "A"]) A.createLayer({ comp_id: comp.id, type: "solid", name: n, expect: GUARD });
    expect(() => A.precomposeLayers({ comp_id: comp.id, layers: [{ index: 1 }, { index: 2 }], move_all_attributes: false, expect: GUARD })).toThrow(/one layer only/);
    const r = A.precomposeLayers({ comp_id: comp.id, layers: [{ name: "C" }, { index: 1 }, { name: "A" }], expect: GUARD });
    expect(r).toMatchObject({ layer_indexes: [1, 3], layer_names: ["A", "C"], new_comp_name: "Pre-comp 1" });
    const after = A.layerStack({ comp_id: comp.id, with_comp_id: r.new_comp_id });
    expect(after.layers.map((l: any) => l.kind)).toEqual(["precomp", "solid"]);
    expect(after.with_comp.layers.map((l: any) => l.name)).toEqual(["A", "C"]);
  });
});

describe("markers.jsx", () => {
  it("adds comp markers, counts a replaced time, and lists them", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["markers.jsx"]);
    A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "a" }, { time: 2, comment: "b", duration: 0.5, label: 3 }], expect: GUARD });
    const r = A.addMarkers({ comp_id: comp.id, markers: [{ time: 1, comment: "a2" }], expect: GUARD });
    expect(r.replaced).toBe(1);
    const list = A.listMarkers({ comp_id: comp.id });
    expect(list.markers.map((m: any) => [m.time, m.comment, m.duration, m.label])).toEqual([
      [1, "a2", 0, 0],
      [2, "b", 0.5, 3],
    ]);
  });

  it("places transcript times in the layer's own time", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "markers.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "VO", expect: GUARD });
    const vo = comp.layer("VO")!;
    vo.startTime = 2;
    vo.stretch = 50;
    const r = A.addMarkers({ comp_id: comp.id, layer: { name: "VO" }, markers: [{ time: 1, comment: "hi" }], relative_to: "layer", expect: GUARD });
    expect(r.placed[0].time).toBe(2.5);
    expect((vo.property("ADBE Marker") as FakeProperty).keyTime(1)).toBe(2.5);
  });

  it("removes by comment within a range, and by index", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["markers.jsx"]);
    A.addMarkers({ comp_id: comp.id, markers: [{ time: 0.5, comment: "Beat" }, { time: 1, comment: "VO" }, { time: 2, comment: "beat" }], expect: GUARD });
    const r = A.removeMarkers({ comp_id: comp.id, comment_contains: "BEAT", start: 1, expect: GUARD });
    expect(r.removed.map((m: any) => m.time)).toEqual([2]);
    A.removeMarkers({ comp_id: comp.id, indexes: [1], expect: GUARD });
    expect(A.listMarkers({ comp_id: comp.id }).markers.map((m: any) => m.comment)).toEqual(["VO"]);
  });
});

describe("keyframes.jsx and audio.jsx", () => {
  function animated() {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "keyframes.jsx", "audio.jsx", "animate.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Ball", expect: GUARD });
    const ball = comp.layer("Ball")!;
    return { project, comp, A, ball, opacity: ball.transform("ADBE Opacity"), pos: ball.transform("ADBE Position") };
  }

  it("removes keys in a range, then all of them keeping the value at a chosen time", () => {
    const { comp, A, opacity } = animated();
    opacity.setValuesAtTimes([0, 1, 2, 3], [0, 100, 50, 0]);
    const path = ["ADBE Transform Group", "ADBE Opacity"];
    const r = A.removeKeys({ comp_id: comp.id, layer: { name: "Ball" }, path, start: 1.5, expect: GUARD });
    expect(r.removed.map((k: any) => k.time)).toEqual([2, 3]);
    const all = A.removeKeys({ comp_id: comp.id, layer: { name: "Ball" }, path, all: true, static_value_at: 0.5, expect: GUARD });
    expect(all).toMatchObject({ numKeys: 0, static_value: 50, static_value_at: 0.5 });
    expect(opacity.value).toBe(50);
    expect(() => A.removeKeys({ comp_id: comp.id, layer: { name: "Ball" }, path, keys: [9], expect: GUARD })).toThrow(/out of range/);
  });

  it("sets cue keys with the property's own value as base, eased, after clearing the span", () => {
    const { comp, A, opacity } = animated();
    opacity.setValueAtTime(1.02, 10);
    const r = A.cueKeys({
      comp_id: comp.id,
      layer: { name: "Ball" },
      path: ["ADBE Transform Group", "ADBE Opacity"],
      keys: [{ time: 0.96, value: null }, { time: 1, value: 40 }, { time: 1.2, value: null }],
      clear_range: [0.96, 1.2],
      expect: GUARD,
    });
    expect(r).toMatchObject({ set: 3, cleared: 1, base: 10 });
    const snap = A.keysSnapshot({ comp_id: comp.id, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"] });
    expect(snap.keys.map((k: any) => [k.time, k.value])).toEqual([
      [0.96, 10],
      [1, 40],
      [1.2, 10],
    ]);
    expect(opacity.keyInInterpolationType(2)).toBe(KeyframeInterpolationType.BEZIER);
    expect(opacity.keyOutTemporalEase(2)[0].influence).toBeCloseTo(33.333, 2);
  });

  it("reports a comp's audio layers and whether its name is unique", () => {
    const { project, comp, A } = animated();
    comp.layer("Ball")!.hasAudio = true;
    project.addComp("Main");
    const info = A.audioCompInfo({ comp_id: comp.id });
    expect(info).toMatchObject({ name: "Main", name_unique: false, fps: 25, frame_duration: 0.04 });
    expect(info.audio_layers.map((l: any) => l.name)).toEqual(["Ball"]);
  });

  it("roves the keys between the first and last given key, and refuses a non-spatial property first", () => {
    const { comp, A, pos, opacity } = animated();
    pos.setValuesAtTimes([0, 1, 2], [[0, 0, 0], [100, 0, 0], [200, 0, 0]]);
    const r = A.setKeyframeEase({ comp_id: comp.id, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Position"], keys: [1, 3], ease: "easy_ease", rove_between: true, expect: GUARD });
    expect(r.roving).toEqual([2]);
    expect(pos.keyRoving(2)).toBe(true);
    const read = A.getKeyframeEase({ comp_id: comp.id, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Position"] });
    expect(read.keyframes.map((k: any) => k.roving)).toEqual([false, true, false]);
    opacity.setValuesAtTimes([0, 1, 2], [0, 50, 100]);
    expect(() => A.setKeyframeEase({ comp_id: comp.id, layer: { name: "Ball" }, path: ["ADBE Transform Group", "ADBE Opacity"], keys: [1, 3], ease: "easy_ease", rove_between: true, expect: GUARD })).toThrow(/spatial properties only/);
    expect(opacity.keyInInterpolationType(1)).toBe(KeyframeInterpolationType.LINEAR);
  });
});

describe("motion.jsx layerBoundsAt", () => {
  it("maps the content box through anchor, scale, rotation, position and the parent", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "motion.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Box", width: 100, height: 50, expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "null", name: "Rig", expect: GUARD });
    const box = comp.layer("Box")!;
    const rig = comp.layer("Rig")!;
    box.transform("ADBE Anchor Point").setValue([50, 25, 0]);
    box.transform("ADBE Position").setValue([10, 0, 0]);
    box.transform("ADBE Scale").setValue([200, 200, 100]);
    box.transform("ADBE Rotate Z").setValue(90);
    box.parent = rig;
    rig.transform("ADBE Position").setValue([300, 200, 0]);
    const out = A.layerBoundsAt({ comp_id: comp.id, layer: { name: "Box" }, times: [1] });
    // 100x50 scaled to 200x100, turned 90 degrees to 100 wide, 200 tall, centred on 310, 200.
    const [l, t, r, b] = out.samples[0].rect.map((v: number) => Math.round(v * 1000) / 1000);
    expect([l, t, r, b]).toEqual([260, 100, 360, 300]);
    expect(out.samples[0].visible).toBe(true);
  });

  it("won't guess for 3D layers, nulls and cameras", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "motion.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Card", three_d: true, expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "null", name: "Rig", expect: GUARD });
    expect(A.layerBoundsAt({ comp_id: comp.id, layer: { name: "Card" }, times: [0] })).toMatchObject({ checkable: false, reason: expect.stringMatching(/3D/) });
    expect(A.layerBoundsAt({ comp_id: comp.id, layer: { name: "Rig" }, times: [0] })).toMatchObject({ checkable: false, reason: expect.stringMatching(/null/) });
  });
});

describe("inventory.jsx", () => {
  function nested() {
    const project = new FakeProject();
    const main = project.addComp("Main");
    const shot = project.addComp("Shot");
    const logo = project.addComp("Logo");
    project.addComp("Old");
    main.layers.add(shot);
    main.layers.add(logo);
    shot.layers.add(logo);
    project.renderQueue.items.push({ comp: main });
    return { project, main, shot, logo };
  }

  it("lists every comp's nesting, the top-level comps and the unused ones", () => {
    const { project } = nested();
    const { A } = loadHost(project, ["inventory.jsx"]);
    const t = A.compTree({});
    const by = (n: string) => t.comps.find((c: any) => c.name === n);
    expect(by("Main")).toMatchObject({ used_in: 0, contains: 2, nesting_depth: 2, in_render_queue: true });
    expect(by("Logo")).toMatchObject({ used_in: 2, contains: 0 });
    expect(t.top_level.map((c: any) => c.name)).toEqual(["Main"]);
    expect(t.unused.map((c: any) => c.name)).toEqual(["Old"]);
  });

  it("shows one comp's tree down and where it is used up", () => {
    const { project, main, logo } = nested();
    const { A } = loadHost(project, ["inventory.jsx"]);
    const down = A.compTree({ comp_id: main.id });
    expect(down.contains.map((n: any) => n.name)).toEqual(["Logo", "Shot"]);
    expect(down.contains[1].contains[0].name).toBe("Logo");
    const up = A.compTree({ comp_id: logo.id });
    expect(up.used_in.map((n: any) => n.name).sort()).toEqual(["Main", "Shot"]);
    expect(up.used_in.find((n: any) => n.name === "Shot").used_in[0].name).toBe("Main");
  });

  it("lists fonts with their layers and finds missing ones", () => {
    const project = new FakeProject();
    const comp = project.addComp("Titles");
    comp.layers.addText("Hello");
    comp.layers.addText("World");
    const helloDoc = (comp.layer("Hello")!.property("ADBE Text Properties") as any).property("ADBE Text Document") as FakeProperty;
    const doc = new TextDocument("Hello");
    doc.font = "Gotham-Bold";
    doc.fontFamily = "Gotham";
    doc.fontObject = { isSubstitute: true };
    helloDoc.staticValue = doc;
    const { A } = loadHost(project, ["inventory.jsx"], { fonts: { missingOrSubstitutedFonts: [{ postScriptName: "Gotham-Bold" }] } });
    const f = A.fontsInUse({});
    expect(f.text_layers).toBe(2);
    // "World" was added last, so it is layer 1 and its font comes first.
    expect(f.fonts.map((x: any) => [x.font, x.missing, x.uses])).toEqual([
      ["ArialMT", false, 1],
      ["Gotham-Bold", true, 1],
    ]);
    expect(f.missing).toEqual(["Gotham-Bold"]);
    expect(f.missing_known).toBe(true);
  });
});

describe("core.jsx paged reads", () => {
  it("filters project items by kind, name and missing footage, sorted and paged", () => {
    const project = new FakeProject();
    const folder = project.addFolder("Footage");
    for (let i = 0; i < 5; i++) project.addFootage(`shot_${i}`, 10, 10, undefined, folder);
    project.addComp("B comp");
    project.addComp("A comp");
    (project.all.find((x: any) => x.name === "shot_3") as any).footageMissing = true;
    const { A } = loadHost(project, []);
    const plain = A.getProject({ depth: 3 });
    expect(plain.total).toBeUndefined();
    expect(plain.items.length).toBe(8);
    const comps = A.getProject({ depth: 20, type: "comp", sort: "name" });
    expect(comps.items.map((i: any) => i.name)).toEqual(["A comp", "B comp"]);
    const paged = A.getProject({ depth: 20, type: "footage", offset: 1, limit: 2 });
    expect(paged).toMatchObject({ total: 5, offset: 1, next_offset: 3, truncated: true });
    expect(paged.items.map((i: any) => i.name)).toEqual(["shot_1", "shot_2"]);
    const missing = A.getProject({ depth: 20, missing_only: true });
    expect(missing.items.map((i: any) => [i.name, i.missing])).toEqual([["shot_3", true]]);
  });

  it("pages and filters a comp's layers, keeping the old shape without paging", () => {
    const { project, comp } = scene();
    for (let i = 0; i < 6; i++) comp.layers.addNull();
    comp.stack.forEach((l: FakeLayer, i: number) => (l.name = i % 2 ? `Odd ${i}` : `Even ${i}`));
    const { A } = loadHost(project, []);
    const plain = A.getComp({ comp_id: comp.id });
    expect(plain.layers.length).toBe(6);
    expect(plain.next_offset).toBeUndefined();
    const page = A.getComp({ comp_id: comp.id, name_contains: "odd", limit: 2 });
    expect(page).toMatchObject({ matched: 3, offset: 0, next_offset: 2, truncated: true });
    expect(page.layers.map((l: any) => l.name)).toEqual(["Odd 1", "Odd 3"]);
  });
});

// Keep the MarkerValue import live for readers: AE's marker values carry these fields.
void MarkerValue;

describe("shapes.jsx", () => {
  it("adds a rectangle with fill and stroke, a polygon and a path, then removes one, looking each step up again", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "shapes.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "shape", name: "Art", expect: GUARD });
    const r = A.shapeEdit({
      comp_id: comp.id,
      layer: { name: "Art" },
      add: [
        { type: "rect", name: "Card", size: [200, 120], roundness: 12, fill: { color: [0, 0.5, 1] }, stroke: { color: [1, 1, 1], width: 4 } },
        { type: "polygon", points: 6, outer_radius: 80 },
        { type: "path", vertices: [[0, 0], [100, 0], [50, 80]], closed: true },
      ],
      expect: GUARD,
    });
    expect(r.added.map((a: any) => a.name)).toEqual(["Card", "polygon 2", "path 3"]);
    const c = A.shapeContents({ comp_id: comp.id, layer: { name: "Art" } });
    expect(c.count).toBe(3);
    const card = c.contents[0];
    expect(card.items.map((i: any) => i.kind)).toEqual(["rect", "stroke", "fill"]);
    expect(card.items[0]).toMatchObject({ size: [200, 120], roundness: 12 });
    expect(card.items[2].color).toEqual([0, 0.5, 1, 1]);
    expect(card.items[1].width).toBe(4);
    expect(c.contents[1].items[0]).toMatchObject({ kind: "star", star_kind: "polygon", points: 6, outer_radius: 80 });
    expect(c.contents[2].items[0]).toMatchObject({ kind: "path", vertices: 3, closed: true });
    A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, remove: [{ name: "polygon 2" }], expect: GUARD });
    expect(A.shapeContents({ comp_id: comp.id, layer: { name: "Art" } }).contents.map((x: any) => x.name)).toEqual(["Card", "path 3"]);
  });

  it("refuses a layer that isn't a shape layer, and an ambiguous name to remove", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "shapes.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "BG", expect: GUARD });
    expect(() => A.shapeContents({ comp_id: comp.id, layer: { name: "BG" } })).toThrow(/not a shape layer/);
    A.createLayer({ comp_id: comp.id, type: "shape", name: "Art", expect: GUARD });
    A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, add: [{ type: "ellipse", name: "Dot", size: [10, 10] }, { type: "ellipse", name: "Dot", size: [20, 20] }], expect: GUARD });
    expect(() => A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, remove: [{ name: "Dot" }], expect: GUARD })).toThrow(/2 contents are named/);
  });
});

describe("production.jsx", () => {
  it("adds properties to the template, renames a controller, names the template and sets an override", () => {
    const project = new FakeProject();
    const tpl = project.addComp("Lower Third");
    const main = project.addComp("Main");
    tpl.layers.addText("Name");
    main.layers.add(tpl);
    const { A } = loadHost(project, ["production.jsx"]);
    A.egpEdit({ comp_id: tpl.id, action: "add", layer: { name: "Name" }, path: ["ADBE Transform Group", "ADBE Opacity"], name: "Fade", expect: GUARD });
    A.egpEdit({ comp_id: tpl.id, action: "rename", index: 1, name: "Opacity", expect: GUARD });
    A.egpEdit({ comp_id: tpl.id, action: "template_name", name: "LT Basic", expect: GUARD });
    expect(A.egpRead({ comp_id: tpl.id })).toMatchObject({ template_name: "LT Basic", controllers: [{ index: 1, name: "Opacity" }] });
    A.egpEdit({ comp_id: main.id, action: "set_override", layer: { index: 1 }, name: "Opacity", value: 40, expect: GUARD });
    const read = A.egpRead({ comp_id: main.id, layer: { index: 1 } });
    expect(read.overrides).toEqual([{ index: 1, name: "Opacity", value: 40 }]);
    expect(() => A.egpEdit({ comp_id: tpl.id, action: "rename", index: 5, name: "x", expect: GUARD })).toThrow(/out of range/);
  });

  it("reads template names from an existing queue item, or a temporary one it removes", () => {
    const project = new FakeProject();
    const comp = project.addComp("Edit");
    const { A, undo } = loadHost(project, ["production.jsx"]);
    expect(A.renderTemplates({})).toMatchObject({ source: "none", needs_item: true });
    const temp = A.renderTemplates({ allow_temp: true, expect: GUARD });
    expect(temp.source).toBe("temporary_item");
    expect(temp.output_modules).toContain("AIFF 48kHz");
    expect(project.renderQueue.numItems).toBe(0);
    expect(undo.begun).toBe(1);
    project.renderQueue.items.add(comp);
    expect(A.renderTemplates({}).source).toBe("existing_item");
    expect(undo.begun).toBe(1);
  });

  it("lists footage files and swaps them in one undo group, as sequences where needed", () => {
    const project = new FakeProject();
    const movie = project.addFootage("plate", 1920, 1080);
    movie.file = { fsName: __filename };
    movie.mainSource.isStill = false;
    const seq = project.addFootage("seq", 1920, 1080);
    seq.file = { fsName: "C:/shots/seq_v001.0001.exr" };
    seq.mainSource.isStill = false;
    const { A } = loadHost(project, ["production.jsx"]);
    const files = A.footageFiles({});
    expect(files.items.map((f: any) => [f.name, f.sequence])).toEqual([
      ["plate", false],
      ["seq", true],
    ]);
    const r = A.versionFootage({ items: [{ item_id: movie.id, path: __filename, sequence: false }], expect: GUARD });
    expect(r.replaced[0]).toMatchObject({ item_id: movie.id, to: __filename });
    expect(() => A.versionFootage({ items: [{ item_id: seq.id, path: "C:/nope/seq_v002.0001.exr", sequence: true }], expect: GUARD })).toThrow(/does not exist/);
  });

  it("checks every op before writing, then writes them in one undo group through setProperty", () => {
    const { project, comp } = scene();
    const { A, undo } = loadHost(project, ["layers.jsx", "production.jsx"]);
    for (const n of ["A", "B"]) A.createLayer({ comp_id: comp.id, type: "solid", name: n, expect: GUARD });
    const opacity = ["ADBE Transform Group", "ADBE Opacity"];
    const before = undo.begun;
    expect(() => A.batchSet({ comp_id: comp.id, ops: [{ layer: { name: "A" }, path: opacity, value: 10 }, { layer: { name: "Z" }, path: opacity, value: 10 }], expect: GUARD })).toThrow(/Op 2: No layer named "Z"/);
    expect(comp.layer("A")!.transform("ADBE Opacity").value).toBe(100);
    const r = A.batchSet({
      comp_id: comp.id,
      ops: [
        { layer: { name: "A" }, path: opacity, value: 25 },
        { layer: { name: "B" }, path: opacity, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] },
      ],
      expect: GUARD,
    });
    expect(r).toEqual({ done: 2 });
    expect(undo.begun - before).toBe(1);
    const read = A.batchRead({ comp_id: comp.id, ops: [{ layer: { name: "A" }, path: opacity }, { layer: { name: "B" }, path: opacity, times: [0, 1, 2] }] });
    expect(read.results[0]).toMatchObject({ value: 25, numKeys: 0 });
    expect(read.results[1].keys).toEqual([
      { time: 0, value: 0 },
      { time: 1, value: 100 },
      { time: 2, value: null, missing: true },
    ]);
  });
});
