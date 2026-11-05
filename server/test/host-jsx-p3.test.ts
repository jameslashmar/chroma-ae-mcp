/**
 * The P3 host functions (masks, text animators, layout, housekeeping) run
 * for real under node:vm against the simulated AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGroup, FakeProject, FakeProperty, GUARD, PropertyValueType, loadHost } from "./support/fake-ae.js";

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

// ---------- wave 5: mask attributes, copies and order, and the full text animator ----------

// The fake gains what these tests need, on the prototype: copies and moves of indexed-group members, mask attributes,
// extra animator properties, wiggly and expression selectors, and variable font axes (all written the way AE's DOM
// behaves as far as it is known; the live behaviour is in the report's unmeasured list).
const flags = { noLockDimensions: false, dupBelow: true, oddCorrelation: false };
const P = (name: string, matchName: string, type: number, value: unknown) => new FakeProperty(name, matchName, type, value);
const EXTRA_ANIM: Record<string, [string, number, unknown]> = {
  "ADBE Text Anchor Point 3D": ["Anchor Point", PropertyValueType.ThreeD, [0, 0, 0]],
  "ADBE Text Skew": ["Skew", PropertyValueType.OneD, 0],
  "ADBE Text Skew Axis": ["Skew Axis", PropertyValueType.OneD, 0],
  "ADBE Text Rotation X": ["X Rotation", PropertyValueType.OneD, 0],
  "ADBE Text Fill Opacity": ["Fill Opacity", PropertyValueType.OneD, 100],
  "ADBE Text Fill Hue": ["Fill Hue", PropertyValueType.OneD, 0],
  "ADBE Text Stroke Color": ["Stroke Color", PropertyValueType.COLOR, [1, 1, 1, 1]],
  "ADBE Text Stroke Width": ["Stroke Width", PropertyValueType.OneD, 0],
  "ADBE Text Track Type": ["Tracking Type", PropertyValueType.OneD, 1],
  "ADBE Text Line Spacing": ["Line Spacing", PropertyValueType.TwoD, [0, 0]],
  "ADBE Text Character Offset": ["Character Offset", PropertyValueType.OneD, 0],
  "ADBE Text Character Range": ["Character Range", PropertyValueType.OneD, 1],
};
// After Effects 26.2.1, measured: a new animator's Properties group already lists every animator property (103) as a
// hidden placeholder. property(matchName) answers for a placeholder, a write to it is refused as hidden, and it takes no
// expression (canSetExpression false). addProperty(matchName) makes that one real and only that one (Skew brings no Skew
// Axis); adding one that is already there changes nothing; canAddProperty is true for every property in the list, added
// or not, and false for a match name that is not in it.
const BASE_ANIM: Record<string, [string, number, unknown]> = {
  "ADBE Text Position 3D": ["Position", PropertyValueType.ThreeD_SPATIAL, [0, 0, 0]],
  "ADBE Text Scale 3D": ["Scale", PropertyValueType.ThreeD, [100, 100, 100]],
  "ADBE Text Rotation": ["Rotation", PropertyValueType.OneD, 0],
  "ADBE Text Opacity": ["Opacity", PropertyValueType.OneD, 100],
  "ADBE Text Fill Color": ["Fill Color", PropertyValueType.COLOR, [1, 0, 0, 1]],
  "ADBE Text Tracking Amount": ["Tracking Amount", PropertyValueType.OneD, 0],
  "ADBE Text Blur": ["Blur", PropertyValueType.TwoD, [0, 0]],
};
const HIDDEN_ERROR = "After Effects error: Can not “set value” with this property, because the property or a parent property is hidden.";
const PLACEHOLDERS = Object.keys({ ...BASE_ANIM, ...EXTRA_ANIM }).length;
function fillPlaceholders(properties: FakeGroup) {
  for (const [mn, [n, t, v]] of Object.entries({ ...BASE_ANIM, ...EXTRA_ANIM })) {
    const q = P(n, mn, t, v) as any;
    q.parentProperty = properties;
    q.canSetExpression = false;
    q.placeholder = true;
    q.setValue = () => {
      throw new Error(HIDDEN_ERROR);
    };
    properties.props.push(q);
  }
  (properties as any).modelsPlaceholders = true;
}
const SELECTOR_FACTORY: Record<string, () => FakeGroup> = {
  "ADBE Text Wiggly Selector": () => {
    const kids = [
      P("Mode", "ADBE Text Selector Mode", PropertyValueType.OneD, 1),
      P("Max Amount", "ADBE Text Wiggly Max Amount", PropertyValueType.OneD, 100),
      P("Min Amount", "ADBE Text Wiggly Min Amount", PropertyValueType.OneD, -100),
      P("Based On", "ADBE Text Range Type2", PropertyValueType.OneD, 1),
      P("Wiggles/Second", "ADBE Text Temporal Freq", PropertyValueType.OneD, 2),
      // AE 26.2.1 calls it ADBE Text Character Correlation; flags.oddCorrelation gives it a name the host does not know.
      P("Correlation", flags.oddCorrelation ? "ADBE Text Some Other Corr" : "ADBE Text Character Correlation", PropertyValueType.OneD, 50),
      P("Temporal Phase", "ADBE Text Temporal Phase", PropertyValueType.OneD, 0),
      P("Spatial Phase", "ADBE Text Spatial Phase", PropertyValueType.OneD, 0),
      P("Random Seed", "ADBE Text Wiggly Random Seed", PropertyValueType.OneD, 0),
    ];
    if (!flags.noLockDimensions) kids.splice(8, 0, P("Lock Dimensions", "ADBE Text Wiggly Lock Dim", PropertyValueType.OneD, 0));
    return new FakeGroup("Wiggly Selector 1", "ADBE Text Wiggly Selector", kids);
  },
  "ADBE Text Expressible Selector": () =>
    new FakeGroup("Expression Selector 1", "ADBE Text Expressible Selector", [
      P("Based On", "ADBE Text Range Type2", PropertyValueType.OneD, 1),
      P("Amount", "ADBE Text Expressible Amount", PropertyValueType.OneD, 100),
    ]),
};
let patched = false;
function patchFake() {
  if (patched) return;
  patched = true;
  const proto = FakeGroup.prototype as any;
  const origAdd = proto.addProperty;
  Object.defineProperty(proto, "propertyIndex", {
    get() {
      return this.parentProperty ? this.parentProperty.props.indexOf(this) + 1 : 1;
    },
    configurable: true,
  });
  proto.addProperty = function (matchName: string) {
    if (this.matchName === "ADBE Text Animator Properties" && (this as any).modelsPlaceholders) {
      const q = this.props.find((x: any) => x.matchName === matchName) as any;
      if (!q) throw new Error(`Can't add ${matchName} to Properties`);
      // Adding makes the placeholder real; adding it again changes nothing.
      if (q.placeholder) {
        delete q.setValue;
        q.placeholder = false;
        q.canSetExpression = matchName !== "ADBE Text Character Range";
      }
      return q;
    }
    if (this.matchName === "ADBE Text Selectors" && SELECTOR_FACTORY[matchName]) {
      const g = SELECTOR_FACTORY[matchName]();
      g.parentProperty = this;
      this.props.push(g);
      return g;
    }
    const made = origAdd.call(this, matchName);
    if (matchName === "ADBE Text Animator") fillPlaceholders(made.property("ADBE Text Animator Properties") as FakeGroup);
    if (matchName === "ADBE Mask Atom") Object.assign(made, { locked: false, maskFeatherFalloff: 9302, maskMotionBlur: 9311, color: [1, 0, 0], rotoBezier: false });
    if (matchName === "ADBE Text Selector") {
      // AE adds Index Start/End/Offset beside the Percent properties; Units decides which pair drives the selection.
      for (const [n, mn] of [["Start", "ADBE Text Index Start"], ["End", "ADBE Text Index End"], ["Offset", "ADBE Text Index Offset"]]) {
        const ip = P(n, mn, PropertyValueType.OneD, 0);
        ip.parentProperty = made;
        made.props.push(ip);
      }
      const adv = made.property("ADBE Text Range Advanced") as FakeGroup;
      for (const [n, mn, v] of [["Mode", "ADBE Text Selector Mode", 1], ["Amount", "ADBE Text Selector Max Amount", 100], ["Smoothness", "ADBE Text Selector Smoothness", 100], ["Random Seed", "ADBE Text Random Seed", 0]] as const) {
        const p = P(n, mn, PropertyValueType.OneD, v);
        p.parentProperty = adv;
        adv.props.push(p);
      }
    }
    return made;
  };
  // AE hides Smoothness unless Shape is Square and Random Seed unless Randomize Order is on, and refuses writes to hidden ones.
  const origSet = (FakeProperty.prototype as any).setValue;
  (FakeProperty.prototype as any).setValue = function (v: unknown) {
    // AE refuses scripted writes to a property of a locked mask.
    for (let a: any = this.parentProperty; a; a = a.parentProperty) {
      if (a.locked === true) throw new Error("The mask is locked");
    }
    const sib = (mn: string) => (this.parentProperty ? (this.parentProperty.props as any[]).find((q) => q.matchName === mn) : undefined);
    if (this.matchName === "ADBE Text Selector Smoothness" || this.matchName === "ADBE Text Random Seed") {
      const shape = (this.parentProperty?.parentProperty as any)?.property?.("ADBE Text Range Shape") ?? sib("ADBE Text Range Shape");
      const rnd = (this.parentProperty?.parentProperty as any)?.property?.("ADBE Text Randomize Order") ?? sib("ADBE Text Randomize Order");
      if (this.matchName === "ADBE Text Selector Smoothness" && shape && shape.value !== 1) throw new Error("Property is hidden");
      if (this.matchName === "ADBE Text Random Seed" && rnd && rnd.value !== 1) throw new Error("Property is hidden");
    }
    return origSet.call(this, v);
  };
  proto.duplicate = function () {
    const parent = this.parentProperty;
    const copy: any = new FakeGroup(`${this.name} 2`, this.matchName, this.props.map((p: any) => P(p.name, p.matchName, p.propertyValueType, p.staticValue)));
    for (const k of ["maskMode", "inverted", "locked", "maskFeatherFalloff", "maskMotionBlur", "color", "rotoBezier"]) copy[k] = this[k];
    copy.parentProperty = parent;
    const at = parent.props.indexOf(this);
    parent.props.splice(flags.dupBelow ? at + 1 : at, 0, copy);
    return copy;
  };
  proto.canAddProperty = function (matchName: string) {
    if (!this.modelsPlaceholders) return true;
    return this.props.some((x: any) => x.matchName === matchName);
  };
  proto.moveTo = function (i: number) {
    const parent = this.parentProperty;
    parent.props.splice(parent.props.indexOf(this), 1);
    parent.props.splice(i - 1, 0, this);
  };
  proto.addVariableFontAxis = function (tag: string) {
    if (this.matchName !== "ADBE Text Animator Properties") throw new Error("addVariableFontAxis works only on an animator's Properties group");
    const p = P(`Axis ${tag}`, `ADBE Text Variable Axis ${tag}`, PropertyValueType.OneD, 0);
    p.parentProperty = this;
    this.props.push(p);
    p.propertyIndex = this.props.length;
    return p;
  };
}

const ENUM_GLOBALS = { MaskFeatherFalloff: { FFO_LINEAR: 9301, FFO_SMOOTH: 9302 }, MaskMotionBlur: { SAME_AS_LAYER: 9311, ON: 9312, OFF: 9313 } };

function maskScene(names = ["A", "B", "C"], withEnums = true) {
  patchFake();
  const { project, comp } = scene();
  const h = loadHost(project, ["layers.jsx", "masks.jsx"]);
  if (withEnums) Object.assign(h.G, ENUM_GLOBALS);
  h.A.createLayer({ comp_id: comp.id, type: "solid", name: "Plate", expect: GUARD });
  h.A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, add: names.map((n) => ({ name: n, shape: "rect", box: [0, 0, 10, 10] })), expect: GUARD });
  const list = () => h.A.maskList({ comp_id: comp.id, layer: { name: "Plate" } }) as any;
  const edit = (a: object) => h.A.maskEdit({ comp_id: comp.id, layer: { name: "Plate" }, expect: GUARD, ...a }) as any;
  return { project, comp, ...h, list, edit, names: () => list().masks.map((m: any) => m.name) as string[] };
}

describe("ae_mask attributes", () => {
  it("sets and reads feather falloff, motion blur, colour, lock and RotoBezier, and warns about RotoBezier", () => {
    const { list, edit } = maskScene(["A"]);
    const r = edit({ set: [{ mask: { index: 1 }, feather_falloff: "linear", motion_blur: "on", color: [0, 1, 0], roto_bezier: true, locked: true }] });
    expect(r.unsupported).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/recomputes its tangents/);
    expect(list().masks[0]).toMatchObject({ feather_falloff: "linear", motion_blur: "on", color: [0, 1, 0], roto_bezier: true, locked: true });
  });

  it("edits a locked mask by unlocking it, then locks it again", () => {
    const { list, edit } = maskScene(["A"]);
    edit({ set: [{ mask: { index: 1 }, locked: true }] });
    expect(list().masks[0].locked).toBe(true);
    edit({ set: [{ mask: { index: 1 }, opacity: 40 }] });
    expect(list().masks[0]).toMatchObject({ opacity: 40, locked: true });
    edit({ set: [{ mask: { index: 1 }, locked: false, opacity: 30 }] });
    expect(list().masks[0]).toMatchObject({ opacity: 30, locked: false });
    edit({ set: [{ mask: { index: 1 }, opacity: 20, locked: true }] });
    expect(list().masks[0]).toMatchObject({ opacity: 20, locked: true });
  });

  it("keeps a locked mask locked when an edit throws", () => {
    const { comp, list, edit } = maskScene(["A"]);
    edit({ set: [{ mask: { index: 1 }, locked: true }] });
    const mask = (comp.layer("Plate") as any).property("ADBE Mask Parade").property(1);
    mask.property("ADBE Mask Offset").setValue = () => {
      throw new Error("Value out of range");
    };
    expect(() => edit({ set: [{ mask: { index: 1 }, opacity: 40, expansion: 5 }] })).toThrow();
    expect(list().masks[0].locked).toBe(true);
  });

  it("validates attribute values before the undo group", () => {
    const { undo, edit, list } = maskScene(["A"]);
    const begun = undo.begun;
    expect(() => edit({ set: [{ mask: { index: 1 }, opacity: 20, feather_falloff: "sharp" }] })).toThrow(/Unknown feather_falloff/);
    expect(() => edit({ set: [{ mask: { index: 1 }, motion_blur: "maybe" }] })).toThrow(/Unknown motion_blur/);
    expect(() => edit({ set: [{ mask: { index: 1 }, color: [2, 0, 0] }] })).toThrow(/color is \[r, g, b\]/);
    expect(undo.begun).toBe(begun);
    expect(list().masks[0].opacity).toBe(100);
  });

  it("skips and reports an attribute this After Effects lacks, and still applies the rest", () => {
    // No MaskFeatherFalloff / MaskMotionBlur enums, and a mask node without maskFeatherFalloff.
    const { list, edit } = maskScene(["A"], false);
    const r = edit({ set: [{ mask: { index: 1 }, opacity: 55, feather_falloff: "smooth", motion_blur: "off" }] });
    expect(r.unsupported.map((u: any) => u.field)).toEqual(["feather_falloff", "motion_blur"]);
    expect(list().masks[0]).toMatchObject({ opacity: 55 });
  });

  it("refuses a locked layer", () => {
    const { comp, edit, undo } = maskScene(["A"]);
    comp.layer("Plate")!.locked = true;
    const begun = undo.begun;
    expect(() => edit({ set: [{ mask: { index: 1 }, opacity: 10 }] })).toThrow(/is locked; unlock it first/);
    expect(undo.begun).toBe(begun);
  });

  it("returns no_op without an undo group when nothing would change", () => {
    const { edit, undo } = maskScene(["A", "B"]);
    const begun = undo.begun;
    expect(edit({ set: [{ mask: { index: 1 } }] })).toMatchObject({ no_op: true, count: 2 });
    expect(edit({ move_to: [{ mask: { index: 2 }, index: 2 }] })).toMatchObject({ no_op: true });
    expect(undo.begun).toBe(begun);
  });
});

describe("ae_mask duplicate and move_to", () => {
  it("duplicates a mask the requested number of times and reports where the copies landed", () => {
    const { edit, names, undo } = maskScene();
    const begun = undo.begun;
    const r = edit({ duplicate: [{ mask: { name: "B" }, count: 2 }] });
    expect(undo.begun).toBe(begun + 1);
    expect(r.count).toBe(5);
    expect(r.duplicated.map((d: any) => [d.source_name, d.index])).toEqual([["B", 3], ["B", 3]]);
    // `index` is where each copy sat when made; `final_index` is where it ends (the second copy pushed the first down).
    expect(r.duplicated.map((d: any) => d.final_index).sort()).toEqual([3, 4]);
    expect(r.duplicated[0]).not.toHaveProperty("token");
    expect(r.plan_order).toEqual([{ original: 1 }, { original: 2 }, { copy_of: 2 }, { copy_of: 2 }, { original: 3 }]);
    expect(names()).toEqual(["A", "B", "B 2", "B 2", "C"]);
    expect(r.order).toEqual(["A", "B", "B 2", "B 2", "C"]);
  });

  it("reads the copy's real position when the copy lands above the source", () => {
    const { edit, names } = maskScene();
    flags.dupBelow = false;
    try {
      const r = edit({ duplicate: [{ mask: { name: "B" } }] });
      expect(r.duplicated[0].index).toBe(2);
      expect(names()).toEqual(["A", "B 2", "B", "C"]);
    } finally {
      flags.dupBelow = true;
    }
  });

  it("moves masks to a new position and reads the order back", () => {
    const { edit, names } = maskScene();
    const r = edit({ move_to: [{ mask: { name: "C" }, index: 1 }] });
    expect(names()).toEqual(["C", "A", "B"]);
    expect(r.moved).toEqual([{ from: 3, to: 1, name: "C", name_at_target: "C" }]);
    expect(r.plan_order).toEqual([{ original: 3 }, { original: 1 }, { original: 2 }]);
    expect(r.order).toEqual(["C", "A", "B"]);
  });

  it("tracks masks through removal, copies, moves and changes in one call", () => {
    const { edit, names, list } = maskScene(["A", "B", "C", "D"]);
    const r = edit({
      set: [{ mask: { name: "D" }, opacity: 25 }],
      remove: [{ name: "A" }],
      duplicate: [{ mask: { name: "C" } }],
      move_to: [{ mask: { name: "D" }, index: 1 }],
      add: [{ name: "E", shape: "rect", box: [0, 0, 5, 5] }],
    });
    expect(names()).toEqual(["D", "B", "C", "C 2", "E"]);
    expect(r.changed).toEqual([{ index: 4, name: "D", final_index: 1 }]);
    expect(list().masks[0]).toMatchObject({ name: "D", opacity: 25 });
    expect(r.count).toBe(5);
  });

  it("lists a stack of more than 100 masks without truncating it", () => {
    const many = Array.from({ length: 150 }, (_, i) => `M${i + 1}`);
    const { list } = maskScene(many);
    const l = list();
    expect(l.count).toBe(150);
    expect(l.masks).toHaveLength(150);
    expect(l.truncated).toBe(false);
  });

  it("refuses bad plans before the undo group and changes nothing", () => {
    const { edit, names, undo } = maskScene();
    const begun = undo.begun;
    expect(() => edit({ move_to: [{ mask: { name: "A" }, index: 4 }] })).toThrow(/past the last mask/);
    expect(() => edit({ duplicate: [{ mask: { name: "A" } }], remove: [{ name: "A" }] })).toThrow(/both duplicated and removed/);
    expect(() => edit({ move_to: [{ mask: { name: "A" }, index: 2 }], remove: [{ name: "A" }] })).toThrow(/both moved and removed/);
    expect(() => edit({ move_to: [{ mask: { name: "A" }, index: 2 }, { mask: { index: 1 }, index: 3 }] })).toThrow(/moved twice/);
    expect(() => edit({ duplicate: [{ mask: { name: "A" }, count: 0 }] })).toThrow(/count/);
    expect(() => edit({ move_to: [{ mask: { name: "Z" }, index: 1 }] })).toThrow(/No mask named/);
    expect(undo.begun).toBe(begun);
    expect(names()).toEqual(["A", "B", "C"]);
  });

  it("warns when the layer's expressions address masks by index or name", () => {
    const { comp, edit } = maskScene();
    const opacity = comp.layer("Plate")!.transform("ADBE Opacity");
    opacity.expression = 'thisLayer.mask(2).maskOpacity + thisLayer.mask("Mask 1").maskFeather[0]';
    const r = edit({ move_to: [{ mask: { name: "C" }, index: 1 }] });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/2 expression reference\(s\)/);
    expect(r.warnings[0]).toMatch(/mask\(2\)/);
    expect(r.warnings[0]).toMatch(/mask\("Mask 1"\)/);
    // No warning for a call that does not reorder, copy or remove.
    expect(edit({ set: [{ mask: { index: 1 }, opacity: 90 }] }).warnings).toEqual([]);
  });
});

// ---------- text animators, wave 5 ----------

function textScene(extra: Record<string, unknown> = {}) {
  patchFake();
  const { project, comp } = scene();
  const h = loadHost(project, ["layers.jsx", "masks.jsx"], extra);
  h.A.createLayer({ comp_id: comp.id, type: "text", text: "Hello World", expect: GUARD });
  const add = (a: object) => h.A.addTextAnimator({ comp_id: comp.id, layer: { index: 1 }, expect: GUARD, ...a }) as any;
  const read = () => h.A.textAnimators({ comp_id: comp.id, layer: { index: 1 } }) as any;
  const layer = () => comp.layer(1)!;
  const doc = () => (layer().property("ADBE Text Properties") as FakeGroup).property("ADBE Text Document") as FakeProperty;
  return { project, comp, ...h, add, read, layer, doc };
}

function addMoreOptions(layer: { property(s: string): unknown }) {
  const tp = layer.property("ADBE Text Properties") as FakeGroup;
  const mo = new FakeGroup("More Options", "ADBE Text More Options", [
    P("Anchor Point Grouping", "ADBE Text Anchor Point Option", PropertyValueType.OneD, 1),
    P("Grouping Alignment", "ADBE Text Anchor Point Align", PropertyValueType.TwoD, [0, 0]),
    P("Fill & Stroke", "ADBE Text Render Order", PropertyValueType.OneD, 1),
    P("Inter-Character Blending", "ADBE Text Character Blend Mode", PropertyValueType.OneD, 1),
  ]);
  mo.parentProperty = tp;
  tp.props.push(mo);
  return mo;
}

function withFonts(A: any, table: Record<string, Array<{ tag: string; min: number; max: number }> | null>) {
  A.fontsResolve = (spec: { postscript: string }) => {
    const axes = table[spec.postscript];
    if (axes === undefined) return { ok: false, duplicates: 0, candidates: [], reason: "No installed font matches" };
    return { ok: true, font: { postscript: spec.postscript, has_design_axes: !!axes?.length, axes: (axes ?? []).map((a) => ({ tag: a.tag, name: a.tag, min: a.min, max: a.max, default: a.min })) }, duplicates: 0, candidates: [] };
  };
}

describe("ae_text_animator properties", () => {
  it("adds each animator property before writing it, because After Effects pre-lists a hidden placeholder for every one", () => {
    // Real AE 26.2.1: property(matchName) on a new animator's Properties group answers for a property nobody added, and a
    // write to that placeholder is refused as hidden. canAddProperty stays true after the add, so it cannot tell added from
    // not added; the host adds every property it writes (adding one twice is harmless).
    const { add, read, layer } = textScene();
    const group = () => ((layer().property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup).property(1)!.property("ADBE Text Animator Properties") as FakeGroup;
    const r = add({ properties: { opacity: 0, position: [0, 30, 0], skew: 12, skew_axis: 30 } });
    expect(r.properties).toEqual(["opacity", "position", "skew", "skew_axis"]);
    // Nothing else was made real: Skew brought no Skew Axis of its own, and the other placeholders are still hidden.
    const real = group().props.filter((q: any) => !q.placeholder).map((q: any) => q.matchName);
    expect(real.sort()).toEqual(["ADBE Text Opacity", "ADBE Text Position 3D", "ADBE Text Skew", "ADBE Text Skew Axis"]);
    expect(group().numProperties).toBe(PLACEHOLDERS);
    expect(group().canAddProperty("ADBE Text Opacity")).toBe(true);
    expect(group().canAddProperty("ADBE Text No Such Property")).toBe(false);
    // The read lists the added properties, not the placeholders. Character Range is the exception: it takes no expression even
    // when added, so an added one cannot be told from its placeholder, and it is always listed.
    const props = read().animators[0].properties.map((p: any) => [p.matchName, p.value]);
    expect(props.map((p: any) => p[0]).sort()).toEqual(["ADBE Text Character Range", "ADBE Text Opacity", "ADBE Text Position 3D", "ADBE Text Skew", "ADBE Text Skew Axis"]);
    expect(props).toContainEqual(["ADBE Text Opacity", 0]);
    expect(props).toContainEqual(["ADBE Text Position 3D", [0, 30, 0]]);
  });

  it("keeps the value of a property when it is added a second time", () => {
    const { add, layer } = textScene();
    add({ properties: { opacity: 25 } });
    const group = ((layer().property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup).property(1)!.property("ADBE Text Animator Properties") as FakeGroup;
    group.addProperty("ADBE Text Opacity");
    expect((group.property("ADBE Text Opacity") as FakeProperty).value).toBe(25);
    expect(group.props.filter((q: any) => q.matchName === "ADBE Text Opacity")).toHaveLength(1);
  });

  it("adds the extended animator properties and reports the match names it used", () => {
    const { add, read } = textScene();
    const r = add({
      properties: {
        anchor_point: [0, -20],
        skew: 12,
        rotation_x: 90,
        fill_opacity: 50,
        fill_hue: 120,
        stroke_color: [1, 0, 0],
        stroke_width: 3,
        tracking_type: 2,
        line_spacing: [0, 30],
        character_offset: 5,
        character_range: 2,
      },
    });
    expect(r.property_matches.character_range.match_name).toBe("ADBE Text Character Range");
    expect(r.property_matches.skew.match_name).toBe("ADBE Text Skew");
    // The Guide's name comes first; the older guess is the fallback.
    expect(r.property_matches.tracking_type.match_name).toBe("ADBE Text Track Type");
    const props = read().animators[0].properties.map((p: any) => [p.matchName, p.value]);
    expect(props).toContainEqual(["ADBE Text Skew", 12]);
    expect(props).toContainEqual(["ADBE Text Stroke Width", 3]);
    expect(props).toContainEqual(["ADBE Text Line Spacing", [0, 30]]);
    expect(props).toContainEqual(["ADBE Text Character Range", 2]);
  });

  it("refuses a bad property value or an unknown property before the undo group", () => {
    const { add, undo, read } = textScene();
    const begun = undo.begun;
    expect(() => add({ properties: { skew: "lots" } })).toThrow(/needs a number/);
    expect(() => add({ properties: { line_spacing: [1] } })).toThrow(/\[x, y\]/);
    expect(() => add({ properties: { fill_color: [2, 0, 0] } })).toThrow(/each 0 to 1/);
    expect(() => add({ properties: { opacity: 120 } })).toThrow(/above 100/);
    expect(() => add({ properties: { wobble: 1 } })).toThrow(/Unknown animator property/);
    expect(() => add({ properties: {} })).toThrow(/at least one animator property/);
    expect(undo.begun).toBe(begun);
    expect(read().count).toBe(0);
  });

  it("removes the animator it just made when an animator property cannot be added", () => {
    const { add, read } = textScene();
    // The fake cannot add this one, like an AE that lacks the property.
    expect(() => add({ properties: { opacity: 0, character_value: 65 } })).toThrow(/would not add the animator property "character_value"/);
    expect(read().count).toBe(0);
  });

  it("refuses a locked layer", () => {
    const { add, layer, undo } = textScene();
    layer().locked = true;
    const begun = undo.begun;
    expect(() => add({ properties: { opacity: 0 } })).toThrow(/is locked; unlock it first/);
    expect(undo.begun).toBe(begun);
  });
});

describe("ae_text_animator selectors", () => {
  it("writes smoothness on a square shape, refuses it with any other shape, and refuses a seed without randomize", () => {
    const { add, read, undo } = textScene();
    add({ properties: { opacity: 0 }, selector: { shape: "square", smoothness: 30, randomize: true, random_seed: 5 } });
    const sel = read().animators[0].selectors[0];
    const value = (mn: string) => sel.children.find((c: any) => c.matchName === mn).value;
    expect(value("ADBE Text Selector Smoothness")).toBe(30);
    expect(value("ADBE Text Random Seed")).toBe(5);
    // Real AE 26.2.1: with a shape other than Square, Smoothness is hidden (a write is refused) and reads 100.
    const begun = undo.begun;
    expect(() => add({ properties: { opacity: 0 }, selector: { shape: "round", smoothness: 30 } })).toThrow(/smoothness applies only to the square shape/);
    expect(() => add({ properties: { opacity: 0 }, selector: { shape: "ramp_up", smoothness: 100 } })).toThrow(/Nothing was changed/);
    expect(undo.begun).toBe(begun);
    expect(read().count).toBe(1);
    expect(() => add({ properties: { opacity: 0 }, selector: { random_seed: 5 } })).toThrow(/randomize: true/);
  });

  it("adds Skew and Skew Axis one by one: Skew brings no companion", () => {
    const { add, read } = textScene();
    const r = add({ properties: { skew: 12, skew_axis: 30, character_offset: 2, character_range: 2 } });
    expect(r.property_matches.skew_axis.match_name).toBe("ADBE Text Skew Axis");
    const props = read().animators[0].properties.map((q: any) => [q.matchName, q.value]);
    expect(props).toContainEqual(["ADBE Text Skew", 12]);
    expect(props).toContainEqual(["ADBE Text Skew Axis", 30]);
    expect(props).toContainEqual(["ADBE Text Character Range", 2]);
  });

  it("builds a range selector with units, mode, amount, smoothness and a seed, and keys a reveal on it", () => {
    const { add, read } = textScene();
    const r = add({
      properties: { opacity: 0 },
      selector: { units: "index", start: 2, end: 8, mode: "intersect", amount: 80, smoothness: 40, random_seed: 7, based_on: "words", shape: "square", randomize: true },
      reveal: { property: "end", from: 2, to: 8, start_time: 0, duration: 1 },
    });
    expect(r.selectors).toHaveLength(1);
    expect(r.selectors[0]).toMatchObject({ index: 1, type: "range" });
    const sel = read().animators[0].selectors[0];
    const value = (mn: string) => sel.children.find((c: any) => c.matchName === mn).value;
    expect(value("ADBE Text Range Units")).toBe(2);
    expect(value("ADBE Text Selector Mode")).toBe(3);
    expect(value("ADBE Text Selector Max Amount")).toBe(80);
    expect(value("ADBE Text Selector Smoothness")).toBe(40);
    expect(value("ADBE Text Random Seed")).toBe(7);
    expect(value("ADBE Text Range Type2")).toBe(3);
    expect(value("ADBE Text Range Shape")).toBe(1);
    expect(value("ADBE Text Randomize Order")).toBe(1);
    // Units is Index, so the selection is driven by the Index properties; the Percent ones stay untouched.
    expect(sel).toMatchObject({ type: "range", units: "index", start: 2, end_keys: 2, start_keys: 0 });
    const kid = (mn: string) => sel.children.find((c: any) => c.matchName === mn);
    expect(kid("ADBE Text Index Start").value).toBe(2);
    expect(kid("ADBE Text Index End")).toMatchObject({ keys: 2 });
    expect(kid("ADBE Text Percent Start")).toMatchObject({ value: 0, keys: 0 });
    expect(kid("ADBE Text Percent End")).toMatchObject({ value: 100, keys: 0 });
    expect(r.selectors[0].fields.start.match_name).toBe("ADBE Text Index Start");
    expect(r.selectors[0].fields.end.match_name).toBe("ADBE Text Index End");
  });

  it("keeps using the Percent properties when units is percentage, and says so when Index properties are missing", () => {
    const { add, read } = textScene();
    add({ properties: { opacity: 0 }, selector: { start: 10, end: 60 } });
    const sel = read().animators[0].selectors[0];
    expect(sel).toMatchObject({ start: 10, end: 60 });
    expect(sel.units).toBeUndefined();
    expect(sel.children.find((c: any) => c.matchName === "ADBE Text Index Start").value).toBe(0);
  });

  it("builds a wiggly selector and an expression selector from the match names After Effects 26.2.1 reports", () => {
    const { add, read } = textScene();
    const r = add({
      properties: { position: [0, 20, 0] },
      selector: { type: "wiggly", mode: "add", max_amount: 80, min_amount: -20, wiggles_per_second: 3, correlation: 10, temporal_phase: 45, spatial_phase: 90, lock_dimensions: true, random_seed: 4, based_on: "characters" },
      more_selectors: [{ type: "expression", expression: "Math.sin(textIndex)*50+50", based_on: "words" }],
    });
    expect(r.selectors.map((s: any) => [s.index, s.type])).toEqual([[1, "wiggly"], [2, "expression"]]);
    expect(r.selectors[0].fields.correlation).toEqual({ match_name: "ADBE Text Character Correlation", name: "Correlation" });
    expect(r.selectors[0].fields.mode).toEqual({ match_name: "ADBE Text Selector Mode", name: "Mode" });
    expect(r.selectors[1].fields.expression).toEqual({ match_name: "ADBE Text Expressible Amount", name: "Amount" });
    const sels = read().animators[0].selectors;
    expect(sels.map((s: any) => s.type)).toEqual(["wiggly", "expression"]);
    const wig = (mn: string) => sels[0].children.find((c: any) => c.matchName === mn).value;
    expect(wig("ADBE Text Wiggly Max Amount")).toBe(80);
    expect(wig("ADBE Text Wiggly Min Amount")).toBe(-20);
    expect(wig("ADBE Text Temporal Freq")).toBe(3);
    expect(wig("ADBE Text Character Correlation")).toBe(10);
    expect(wig("ADBE Text Selector Mode")).toBe(1);
    expect(wig("ADBE Text Wiggly Lock Dim")).toBe(1);
    expect(wig("ADBE Text Wiggly Random Seed")).toBe(4);
    const amount = sels[1].children.find((c: any) => c.matchName === "ADBE Text Expressible Amount");
    expect(amount.expression).toBe("Math.sin(textIndex)*50+50");
    expect(amount.expression_error).toBe("");
  });

  it("finds a wiggly child whose match name it does not know by its display name", () => {
    const { add, read } = textScene();
    flags.oddCorrelation = true;
    try {
      const r = add({ properties: { position: [0, 20, 0] }, selector: { type: "wiggly", correlation: 10 } });
      expect(r.selectors[0].fields.correlation).toEqual({ match_name: "ADBE Text Some Other Corr", name: "Correlation" });
    } finally {
      flags.oddCorrelation = false;
    }
    expect(read().animators[0].selectors[0].children.find((c: any) => c.matchName === "ADBE Text Some Other Corr").value).toBe(10);
  });

  it("keys the reveal on the first range selector when a wiggly selector comes first", () => {
    const { add, read } = textScene();
    add({ properties: { opacity: 0 }, selector: { type: "wiggly" }, more_selectors: [{ type: "range", start: 0 }], reveal: { from: 0, to: 100, start_time: 0, duration: 1 } });
    const sels = read().animators[0].selectors;
    expect(sels[1]).toMatchObject({ type: "range", start_keys: 2 });
  });

  it("refuses fields that belong to another selector type, before the undo group", () => {
    const { add, undo } = textScene();
    const begun = undo.begun;
    expect(() => add({ properties: { opacity: 0 }, selector: { type: "wiggly", start: 10 } })).toThrow(/"start" does not belong to a wiggly selector/);
    expect(() => add({ properties: { opacity: 0 }, selector: { type: "expression" } })).toThrow(/needs `expression`/);
    expect(() => add({ properties: { opacity: 0 }, selector: { based_on: "syllables" } })).toThrow(/Unknown based_on/);
    expect(() => add({ properties: { opacity: 0 }, selector: { type: "wiggly" }, reveal: { from: 0, to: 1, start_time: 0, duration: 1 } })).toThrow(/reveal keys a range selector/);
    expect(undo.begun).toBe(begun);
  });

  it("fails with the selector's real children and leaves nothing behind when a selector child cannot be found", () => {
    const { add, read, layer } = textScene();
    addMoreOptions(layer());
    flags.noLockDimensions = true;
    try {
      expect(() => add({ properties: { opacity: 0 }, selector: { type: "wiggly", lock_dimensions: true }, grouping: { anchor_point_grouping: "word" } })).toThrow(
        /no "lock_dimensions" property.*Its children are: .*ADBE Text Selector Mode/
      );
    } finally {
      flags.noLockDimensions = false;
    }
    expect(read().count).toBe(0);
    expect(read().more_options.anchor_point_grouping).toBe(1);
  });
});

describe("ae_text_animator grouping", () => {
  it("sets More Options and reads them back", () => {
    const { add, read, layer } = textScene();
    addMoreOptions(layer());
    const r = add({ properties: { rotation_x: 45 }, grouping: { anchor_point_grouping: "line", grouping_alignment: [50, 100], fill_and_stroke: 3, inter_character_blending: 2 } });
    expect(r.grouping).toEqual({ anchor_point_grouping: 3, grouping_alignment: [50, 100], fill_and_stroke: 3, inter_character_blending: 2 });
    expect(read().more_options).toEqual({ anchor_point_grouping: 3, grouping_alignment: [50, 100], fill_and_stroke: 3, inter_character_blending: 2 });
  });

  it("refuses grouping that this layer lacks, or with keyframes, or out of range, before the undo group", () => {
    const { add, layer, undo } = textScene();
    const begun = undo.begun;
    expect(() => add({ properties: { opacity: 0 }, grouping: { anchor_point_grouping: "word" } })).toThrow(/has no anchor_point_grouping property/);
    const mo = addMoreOptions(layer());
    expect(() => add({ properties: { opacity: 0 }, grouping: { fill_and_stroke: 9 } })).toThrow(/menu index from 1 to 3/);
    expect(() => add({ properties: { opacity: 0 }, grouping: { anchor_point_grouping: "paragraph" } })).toThrow(/Unknown anchor_point_grouping/);
    (mo.property("ADBE Text Render Order") as FakeProperty).setValueAtTime(0, 1);
    expect(() => add({ properties: { opacity: 0 }, grouping: { fill_and_stroke: 2 } })).toThrow(/has keyframes/);
    expect(undo.begun).toBe(begun);
  });
});

describe("ae_text_animator variable font axes", () => {
  const inter = [
    { tag: "wght", min: 100, max: 900 },
    { tag: "wdth", min: 75, max: 125 },
  ];

  it("adds a font's axis with its value and reports where it landed", () => {
    const { add, read, A, doc } = textScene();
    doc().staticValue.font = "Inter-Variable";
    withFonts(A, { "Inter-Variable": inter });
    const r = add({ properties: { opacity: 100 }, variable_axes: [{ tag: "wght", value: 700 }, { tag: "wdth", value: 90 }] });
    expect(r.variable_axes.map((a: any) => [a.tag, a.value, a.index, a.applies_to])).toEqual([["wght", 700, PLACEHOLDERS + 1, ["Inter-Variable"]], ["wdth", 90, PLACEHOLDERS + 2, ["Inter-Variable"]]]);
    expect(r.warnings).toEqual([]);
    const props = read().animators[0].properties;
    // Only the added properties are read (opacity, the always-listed Character Range, then the two axes), each with its place in the group.
    expect(props.map((q: any) => q.matchName)).toEqual(["ADBE Text Opacity", "ADBE Text Character Range", "ADBE Text Variable Axis wght", "ADBE Text Variable Axis wdth"]);
    expect(props[2]).toMatchObject({ index: PLACEHOLDERS + 1, value: 700 });
    expect(props[3]).toMatchObject({ index: PLACEHOLDERS + 2, value: 90 });
  });

  // AE 26.2.1 (probed): addVariableFontAxis can return no property, and the Properties group already lists
  // VF Axis 1..8 as hidden placeholders (numProperties stays put), so the last slot is a hidden one.
  function withSilentAxisMethod(body: () => void, makeLive: boolean) {
    const proto = FakeGroup.prototype as any;
    const saved = proto.addVariableFontAxis;
    proto.addVariableFontAxis = function (tag: string) {
      if (!this.vfSlots) {
        this.vfSlots = [];
        for (let n = 1; n <= 8; n++) {
          const q = P(`VF Axis ${n}`, `ADBE Text VF Axis ${n}`, PropertyValueType.OneD, 0) as any;
          q.parentProperty = this;
          q.canSetExpression = false;
          q.setValue = () => {
            throw new Error(HIDDEN_ERROR);
          };
          this.props.push(q);
          q.propertyIndex = this.props.length;
          this.vfSlots.push(q);
        }
      }
      if (makeLive) {
        const q = this.vfSlots.find((x: any) => x.canSetExpression === false);
        delete q.setValue;
        q.canSetExpression = true;
        q.name = `VF Axis ${tag}`;
      }
      return undefined;
    };
    try {
      body();
    } finally {
      proto.addVariableFontAxis = saved;
    }
  }

  it("takes the slot that became usable when the add returns no property, not the last (hidden) one", () => {
    const { add, A, doc, layer } = textScene();
    doc().staticValue.font = "Inter-Variable";
    withFonts(A, { "Inter-Variable": inter });
    withSilentAxisMethod(() => {
      const r = add({ properties: { opacity: 100 }, variable_axes: [{ tag: "wght", value: 700 }, { tag: "wdth", value: 90 }] });
      expect(r.variable_axes.map((a: any) => [a.tag, a.value, a.index])).toEqual([["wght", 700, PLACEHOLDERS + 1], ["wdth", 90, PLACEHOLDERS + 2]]);
      const group = ((layer().property("ADBE Text Properties") as FakeGroup).property("ADBE Text Animators") as FakeGroup).property(1)!.property("ADBE Text Animator Properties") as FakeGroup;
      expect((group.property(PLACEHOLDERS + 1) as FakeProperty).value).toBe(700);
      expect((group.property(PLACEHOLDERS + 2) as FakeProperty).value).toBe(90);
    }, true);
  });

  it("fails clearly and keeps nothing when the add returns no property and no slot became usable", () => {
    const { add, read, A, doc } = textScene();
    doc().staticValue.font = "Inter-Variable";
    withFonts(A, { "Inter-Variable": inter });
    withSilentAxisMethod(() => {
      expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 700 }] })).toThrow(/did not say which property it is/);
    }, false);
    expect(read().count).toBe(0);
  });

  it("allows an animator that is only axes", () => {
    const { add, A, doc } = textScene();
    doc().staticValue.font = "Inter-Variable";
    withFonts(A, { "Inter-Variable": inter });
    expect(add({ variable_axes: [{ tag: "wght", value: 300 }] }).properties).toEqual([]);
  });

  it("refuses an axis the font lacks, a value outside the font's range, and a repeated tag", () => {
    const { add, A, doc, undo, read } = textScene();
    doc().staticValue.font = "Inter-Variable";
    withFonts(A, { "Inter-Variable": inter });
    const begun = undo.begun;
    expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "slnt", value: -5 }] })).toThrow(/has no axis "slnt".*Its axes: wght, wdth/);
    expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 1200 }] })).toThrow(/can't go above 900/);
    expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 50 }] })).toThrow(/can't go below 100/);
    expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 400 }, { tag: "wght", value: 500 }] })).toThrow(/given twice/);
    expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wgh", value: 400 }] })).toThrow(/4 characters/);
    expect(undo.begun).toBe(begun);
    expect(read().count).toBe(0);
  });

  it("says a font is not variable, and still allows a custom uppercase tag with a warning", () => {
    const { add, A, doc } = textScene();
    doc().staticValue.font = "ArialMT";
    withFonts(A, { ArialMT: [] });
    expect(() => add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 400 }] })).toThrow(/It is not a variable font/);
    const r = add({ properties: { opacity: 0 }, variable_axes: [{ tag: "GRAD", value: 10 }] });
    expect(r.variable_axes[0]).toMatchObject({ tag: "GRAD", custom: true, applies_to: [] });
    expect(r.warnings.join(" ")).toMatch(/could not be checked against the font's axes/);
  });

  it("treats a font that could not be found as unchecked, not as a font without axes", () => {
    const { add, A, doc } = textScene();
    doc().staticValue.font = "Ghost-Variable";
    withFonts(A, {});
    const r = add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 400 }] });
    expect(r.variable_axes[0]).toMatchObject({ tag: "wght", applies_to: [] });
    expect(r.warnings.join(" ")).toMatch(/could not be checked/);
  });

  it("applies an axis only where the font has it on a mixed-font layer, and says so", () => {
    const { add, A, doc } = textScene();
    const d = doc().staticValue;
    d.font = "Inter-Variable";
    d.characterRange = (i: number) => ({ font: i < 3 ? "Inter-Variable" : "ArialMT" });
    withFonts(A, { "Inter-Variable": inter, ArialMT: [] });
    const r = add({ properties: { opacity: 0 }, variable_axes: [{ tag: "wght", value: 600 }] });
    expect(r.variable_axes[0]).toMatchObject({ applies_to: ["Inter-Variable"], skipped_fonts: ["ArialMT"] });
    expect(r.warnings.join(" ")).toMatch(/applies only where the font has it; these fonts in the layer do not: ArialMT/);
  });

  it("goes ahead with a warning when the font data cannot be read", () => {
    const { add, A } = textScene();
    delete A.fontsResolve;
    const r = add({ variable_axes: [{ tag: "wght", value: 500 }] });
    expect(r.variable_axes[0]).toMatchObject({ tag: "wght", applies_to: [] });
    expect(r.warnings.join(" ")).toMatch(/could not be checked/);
  });

  it("refuses below After Effects 26 and when the member is missing", () => {
    const old = textScene({ version: "25.1" });
    expect(() => old.add({ variable_axes: [{ tag: "wght", value: 400 }] })).toThrow(/need After Effects 26.0 or newer \(this is 25.1\)/);
    expect(old.read().count).toBe(0);
    const { add } = textScene();
    const proto = FakeGroup.prototype as any;
    const saved = proto.addVariableFontAxis;
    delete proto.addVariableFontAxis;
    try {
      expect(() => add({ variable_axes: [{ tag: "wght", value: 400 }] })).toThrow(/no PropertyGroup.addVariableFontAxis/);
    } finally {
      proto.addVariableFontAxis = saved;
    }
  });
});
