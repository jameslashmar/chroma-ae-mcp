/**
 * The P3 host functions (masks, text animators, layout, housekeeping) run
 * for real under node:vm against the simulated AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

function scene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  return { project, comp };
}

describe("masks.jsx", () => {
  it("adds a rectangle and an ellipse mask, changes one and removes the other", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "masks.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
    const r = A.maskEdit({
      comp_id: comp.id,
      layer: { name: "Plate" },
      add: [
        { name: "Window", shape: "rect", box: [10, 20, 100, 50], mode: "subtract", feather: [4, 4] },
        { shape: "ellipse", box: [0, 0, 200, 100], inverted: true, expansion: -3 },
      ],
      expect: GUARD,
    });
    expect(r.added.map((a: any) => a.name)).toEqual(["Window", "Mask 2"]);
    const list = A.maskList({ comp_id: comp.id, layer: { name: "Plate" } });
    expect(list.masks[0]).toMatchObject({ name: "Window", mode: "subtract", feather: [4, 4], vertices: 4, box: [10, 20, 110, 70] });
    expect(list.masks[1]).toMatchObject({ inverted: true, expansion: -3, vertices: 4, box: [0, 0, 200, 100] });
    A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, set: [{ mask: { name: "Window" }, opacity: 50, mode: "add" }], remove: [{ index: 2 }], expect: GUARD });
    const after = A.maskList({ comp_id: comp.id, layer: { name: "Plate" } });
    expect(after.count).toBe(1);
    expect(after.masks[0]).toMatchObject({ name: "Window", mode: "add", opacity: 50 });
  });
});

describe("masks.jsx text animators", () => {
  it("adds an animator with properties, a selector and a keyframed reveal", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "masks.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "text", text: "Hello", expect: GUARD });
    const r = A.addTextAnimator({
      comp_id: comp.id,
      layer: { index: 1 },
      name: "Reveal",
      properties: { opacity: 0, position: [0, 40, 0] },
      selector: { based_on: "words", shape: "ramp_up", ease_high: 50 },
      reveal: { from: 0, to: 100, start_time: 0.5, duration: 1 },
      expect: GUARD,
    });
    expect(r).toMatchObject({ index: 1, name: "Reveal" });
    const read = A.textAnimators({ comp_id: comp.id, layer: { index: 1 } });
    const anim = read.animators[0];
    expect(anim.properties.map((p: any) => [p.matchName, p.value])).toEqual([
      ["ADBE Text Opacity", 0],
      ["ADBE Text Position 3D", [0, 40, 0]],
    ]);
    expect(anim.selectors[0]).toMatchObject({ start_keys: 2, end: 100 });
    const adv = (comp.layer(1)!.property("ADBE Text Properties") as any)
      .property("ADBE Text Animators")
      .property(1)
      .property("ADBE Text Selectors")
      .property(1)
      .property("ADBE Text Range Advanced");
    expect([adv.property("ADBE Text Range Type2").value, adv.property("ADBE Text Range Shape").value, adv.property("ADBE Text Levels Max Ease").value]).toEqual([3, 2, 50]);
  });

  it("refuses an unknown property and a layer that isn't text", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "masks.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "text", text: "Hi", expect: GUARD });
    expect(() => A.addTextAnimator({ comp_id: comp.id, layer: { index: 1 }, properties: { wobble: 1 }, expect: GUARD })).toThrow(/Unknown animator property/);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "BG", expect: GUARD });
    expect(() => A.textAnimators({ comp_id: comp.id, layer: { name: "BG" } })).toThrow(/not a text layer/);
  });
});

describe("layout.jsx", () => {
  function boxes() {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "layout.jsx"]);
    const xs: Array<[string, number]> = [
      ["A", 100],
      ["B", 250],
      ["C", 500],
    ];
    for (const [n, x] of xs) {
      A.createLayer({ comp_id: comp.id, type: "solid", name: n, width: 40, height: 20, expect: GUARD });
      comp.layer(n)!.transform("ADBE Position").setValue([x, 100, 0]);
    }
    return { project, comp, A };
  }

  it("aligns left edges to the layers' own box, and right edges to action safe", () => {
    const { comp, A } = boxes();
    const r = A.alignLayers({ comp_id: comp.id, layers: [{ name: "A" }, { name: "C" }], align: "left", to: "layers", expect: GUARD });
    expect(r.box[0]).toBe(100);
    const b = A.boundsOf({ comp_id: comp.id, layers: [{ name: "A" }, { name: "C" }] });
    expect(b.layers.map((l: any) => l.rect[0])).toEqual([100, 100]);
    A.alignLayers({ comp_id: comp.id, layers: [{ name: "B" }], align: "right", to: "action_safe", expect: GUARD });
    expect(A.boundsOf({ comp_id: comp.id, layers: [{ name: "B" }] }).layers[0].rect[2]).toBeCloseTo(608, 6);
  });

  it("distributes centres evenly between the outermost layers", () => {
    const { comp, A } = boxes();
    A.alignLayers({ comp_id: comp.id, layers: [{ name: "C" }, { name: "A" }, { name: "B" }], distribute: "horizontal", expect: GUARD });
    // Anchor at the top-left corner, so position x = box left; centres 120, 320, 520.
    const xs = ["A", "B", "C"].map((n) => (comp.layer(n)!.transform("ADBE Position").value as number[])[0]);
    expect(xs).toEqual([100, 300, 500]);
  });

  it("refuses animated positions without shift_keys, then moves every key with it", () => {
    const { comp, A } = boxes();
    const pos = comp.layer("A")!.transform("ADBE Position");
    pos.setValuesAtTimes([0, 1], [[100, 100, 0], [200, 100, 0]]);
    expect(() => A.alignLayers({ comp_id: comp.id, layers: [{ name: "A" }], align: "top", expect: GUARD })).toThrow(/shift_keys/);
    A.alignLayers({ comp_id: comp.id, layers: [{ name: "A" }], align: "top", time: 0, shift_keys: true, expect: GUARD });
    expect(pos.keys.map((k) => (k.value as number[])[1])).toEqual([0, 0]);
  });

  it("refuses parented and 3D layers", () => {
    const { comp, A } = boxes();
    comp.layer("A")!.parent = comp.layer("B");
    comp.layer("C")!.threeDLayer = true;
    expect(() => A.alignLayers({ comp_id: comp.id, layers: [{ name: "A" }], align: "left", expect: GUARD })).toThrow(/parented/);
    expect(() => A.alignLayers({ comp_id: comp.id, layers: [{ name: "C" }], align: "left", expect: GUARD })).toThrow(/3D/);
  });

  it("lists unused footage and empty folders, and removes them after checking again", () => {
    const { project, comp } = scene();
    const used = project.addFootage("used.png", 10, 10);
    project.addFootage("spare.png", 10, 10);
    project.addFolder("Empty");
    comp.layers.add(used);
    const { A } = loadHost(project, ["layout.jsx"]);
    const u = A.unusedItems({ empty_folders: true });
    expect(u.items.map((i: any) => i.name)).toEqual(["spare.png"]);
    expect(u.folders.map((f: any) => f.name)).toEqual(["Empty"]);
    expect(() => A.purgeItems({ ids: [used.id], expect: GUARD })).toThrow(/used by a comp/);
    expect(() => A.purgeItems({ ids: [comp.id], expect: GUARD })).toThrow(/is a comp/);
    const r = A.purgeItems({ ids: [...u.items.map((i: any) => i.id), ...u.folders.map((f: any) => f.id)], expect: GUARD });
    expect(r.removed.map((x: any) => x.name)).toEqual(["spare.png", "Empty"]);
    expect(project.all.map((x: any) => x.name)).toEqual(["Main", "used.png"]);
  });

  it("exports a template only from a saved, unchanged project with controllers", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layout.jsx"]);
    expect(() => A.exportMogrt({ comp_id: comp.id, expect: GUARD })).toThrow(/no Essential Graphics controllers/);
    comp.controllers.push("Title");
    expect(() => A.exportMogrt({ comp_id: comp.id, expect: GUARD })).toThrow(/Save the project first/);
    project.file = { fsName: "C:/jobs/x.aep" };
    project.dirty = true;
    const saved = { project_path: "C:/jobs/x.aep" };
    expect(() => A.exportMogrt({ comp_id: comp.id, expect: saved })).toThrow(/unsaved changes/);
    project.dirty = false;
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chroma-mogrt-")), "t.mogrt");
    expect(A.exportMogrt({ comp_id: comp.id, path: out, overwrite: true, expect: saved })).toMatchObject({ exported: true, controllers: 1 });
    expect(comp.exported).toEqual([{ overwrite: true, path: out }]);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("scans fonts, sizes and colours of text, shapes and solids", () => {
    const { project, comp } = scene();
    const { A } = loadHost(project, ["layers.jsx", "shapes.jsx", "layout.jsx"]);
    A.createLayer({ comp_id: comp.id, type: "solid", name: "BG", color: [0.1, 0.2, 0.3], expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "shape", name: "Art", expect: GUARD });
    A.shapeEdit({ comp_id: comp.id, layer: { name: "Art" }, add: [{ type: "ellipse", size: [10, 10], fill: { color: [1, 0, 0] } }], expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "text", text: "Title", expect: GUARD });
    A.createLayer({ comp_id: comp.id, type: "null", name: "Rig", expect: GUARD });
    const s = A.styleScan({ comp_id: comp.id });
    expect(s.layers.map((l: any) => [l.name, l.kind])).toEqual([
      ["Title", "text"],
      ["Art", "shape"],
      ["BG", "solid"],
    ]);
    expect(s.layers[0]).toMatchObject({ font: "ArialMT", font_size: 72, colours: [{ role: "fill", rgb: [1, 1, 1] }] });
    expect(s.layers[1].colours[0]).toMatchObject({ role: "fill", rgb: [1, 0, 0] });
    expect(s.layers[2].colours[0].rgb).toEqual([0.1, 0.2, 0.3]);
  });
});
