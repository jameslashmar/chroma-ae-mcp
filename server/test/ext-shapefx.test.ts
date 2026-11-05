/**
 * Wave 5 "shapefx": ae_set_effect (move_to, duplicate, popup labels, input layer + stage),
 * the layer-style route in ae_add_effect, ae_shape (stroke details, gradients, fill rule,
 * duplicate, move) and ae_path_operator (Merge Paths, Round Corners, Zig Zag, Pucker & Bloat,
 * Twist, Wiggle Paths, Wiggle Transform).
 *
 * The fake AE has no moveTo, duplicate, effect factories or these shape items, so this file
 * patches them in locally (and puts the originals back afterwards).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeAddEffectSchema,
  AeSetEffectSchema,
  effectsTools,
  paramMismatches,
  reorderStack,
  stackMismatches,
} from "../src/tools/ext/effects.js";
import { AePathOperatorSchema, genericMismatches, operatorMismatches, pathsTools } from "../src/tools/ext/paths.js";
import { AeShapeSchema, applyMoves, shapeMismatches, shapesTools } from "../src/tools/ext/shapes.js";
import { FakeGroup, FakeProject, FakeProperty, GUARD, loadHost, PropertyType, PropertyValueType } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const expectArg = { project_path: "<unsaved>" };
const effectTool = (n: string) => effectsTools.find((t) => t.name === n)!;
const shapeTool = shapesTools.find((t) => t.name === "ae_shape")!;
const operatorTool = pathsTools.find((t) => t.name === "ae_path_operator")!;

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-shapefx-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
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

// ---------- a fake AE with the members these tools use ----------

const P = (name: string, matchName: string, type: number, value: unknown) => new FakeProperty(name, matchName, type, value);

const opts = { dropTaper: false, dropMiterLimit: false, noStages: false, noLabels: false, dupBefore: false, dupUnlocatable: false };

/** A layer picker; with stage support it behaves like AE 26.5's. */
function layerPicker(name: string, matchName: string) {
  const prop: any = P(name, matchName, PropertyValueType.LAYER_INDEX, 0);
  if (!opts.noStages) {
    prop.pair = [0, 0];
    prop.safeLimit = 3;
    prop.cycleLayer = -1;
    prop.setInputLayerAndStage = function (layerIndex: number, stage: number) {
      if (layerIndex === this.cycleLayer) throw new Error("Cycle");
      this.pair = [layerIndex, stage];
      this.staticValue = layerIndex;
    };
    prop.getInputStageCycleSafeLimit = function () {
      return this.safeLimit;
    };
    Object.defineProperty(prop, "inputLayerAndStage", { get: () => prop.pair });
  }
  return prop;
}

function popup(name: string, matchName: string, value: number, labels: string[]) {
  const prop: any = P(name, matchName, PropertyValueType.OneD, value);
  if (!opts.noLabels) {
    prop.propertyParameters = labels;
    Object.defineProperty(prop, "valueText", { get: () => labels[prop.staticValue - 1] });
  }
  return prop;
}

const effect = (name: string, matchName: string, children: any[]) => {
  const g: any = new FakeGroup(name, matchName, children);
  g.enabled = true;
  return g;
};

const FACTORY: Record<string, (n: number) => any> = {
  "ADBE Gaussian Blur 2": () =>
    effect("Gaussian Blur", "ADBE Gaussian Blur 2", [
      P("Blurriness", "ADBE Gaussian Blur 2-0001", PropertyValueType.OneD, 0),
      popup("Blur Dimensions", "ADBE Gaussian Blur 2-0002", 1, ["Horizontal and Vertical", "Horizontal", "Vertical"]),
      P("Repeat Edge Pixels", "ADBE Gaussian Blur 2-0003", PropertyValueType.OneD, 0),
    ]),
  "ADBE Set Matte3": () =>
    effect("Set Matte", "ADBE Set Matte3", [layerPicker("Take Matte From Layer", "ADBE Set Matte3-0001"), P("Invert Matte", "ADBE Set Matte3-0003", PropertyValueType.OneD, 0)]),
  "ADBE Glo2": () => effect("Glow", "ADBE Glo2", [P("Glow Radius", "ADBE Glo2-0003", PropertyValueType.OneD, 10)]),
  // shape items the fake does not know
  "ADBE Vector Graphic - Fill": (n) =>
    new FakeGroup(`Fill ${n}`, "ADBE Vector Graphic - Fill", [
      P("Color", "ADBE Vector Fill Color", PropertyValueType.COLOR, [1, 0, 0, 1]),
      P("Opacity", "ADBE Vector Fill Opacity", PropertyValueType.OneD, 100),
      P("Fill Rule", "ADBE Vector Fill Rule", PropertyValueType.OneD, 1),
    ]),
  "ADBE Vector Graphic - Stroke": (n) =>
    new FakeGroup(`Stroke ${n}`, "ADBE Vector Graphic - Stroke", [
      P("Color", "ADBE Vector Stroke Color", PropertyValueType.COLOR, [1, 1, 1, 1]),
      P("Stroke Width", "ADBE Vector Stroke Width", PropertyValueType.OneD, 2),
      P("Opacity", "ADBE Vector Stroke Opacity", PropertyValueType.OneD, 100),
      P("Line Cap", "ADBE Vector Stroke Line Cap", PropertyValueType.OneD, 1),
      P("Line Join", "ADBE Vector Stroke Line Join", PropertyValueType.OneD, 1),
      ...(opts.dropMiterLimit ? [] : [P("Miter Limit", "ADBE Vector Stroke Miter Limit", PropertyValueType.OneD, 4)]),
      new FakeGroup("Dashes", "ADBE Vector Stroke Dashes", []),
      ...(opts.dropTaper
        ? []
        : [
            new FakeGroup("Taper", "ADBE Vector Stroke Taper", [
              P("Start Length", "ADBE Vector Taper Start Length", PropertyValueType.OneD, 0),
              P("End Length", "ADBE Vector Taper End Length", PropertyValueType.OneD, 0),
              P("Start Width", "ADBE Vector Taper Start Width", PropertyValueType.OneD, 100),
              P("End Width", "ADBE Vector Taper End Width", PropertyValueType.OneD, 100),
              P("Start Ease", "ADBE Vector Taper Start Ease", PropertyValueType.OneD, 0),
              P("End Ease", "ADBE Vector Taper End Ease", PropertyValueType.OneD, 0),
            ]),
            new FakeGroup("Wave", "ADBE Vector Stroke Wave", [
              P("Amount", "ADBE Vector Taper Wave Amount", PropertyValueType.OneD, 0),
              P("Wavelength", "ADBE Vector Taper Wavelength", PropertyValueType.OneD, 100),
              P("Phase", "ADBE Vector Taper Wave Phase", PropertyValueType.OneD, 0),
            ]),
          ]),
    ]),
  "ADBE Vector Graphic - G-Fill": (n) =>
    new FakeGroup(`Gradient Fill ${n}`, "ADBE Vector Graphic - G-Fill", [
      P("Fill Rule", "ADBE Vector Fill Rule", PropertyValueType.OneD, 1),
      P("Type", "ADBE Vector Grad Type", PropertyValueType.OneD, 1),
      P("Start Point", "ADBE Vector Grad Start Pt", PropertyValueType.TwoD, [-50, 0]),
      P("End Point", "ADBE Vector Grad End Pt", PropertyValueType.TwoD, [50, 0]),
      P("Highlight Length", "ADBE Vector Grad HiLite Length", PropertyValueType.OneD, 0),
      P("Highlight Angle", "ADBE Vector Grad HiLite Angle", PropertyValueType.OneD, 0),
      P("Opacity", "ADBE Vector Fill Opacity", PropertyValueType.OneD, 100),
    ]),
  "ADBE Vector Graphic - G-Stroke": (n) =>
    new FakeGroup(`Gradient Stroke ${n}`, "ADBE Vector Graphic - G-Stroke", [
      P("Type", "ADBE Vector Grad Type", PropertyValueType.OneD, 1),
      P("Start Point", "ADBE Vector Grad Start Pt", PropertyValueType.TwoD, [-50, 0]),
      P("End Point", "ADBE Vector Grad End Pt", PropertyValueType.TwoD, [50, 0]),
      P("Stroke Width", "ADBE Vector Stroke Width", PropertyValueType.OneD, 2),
      P("Opacity", "ADBE Vector Stroke Opacity", PropertyValueType.OneD, 100),
      P("Line Cap", "ADBE Vector Stroke Line Cap", PropertyValueType.OneD, 1),
      P("Line Join", "ADBE Vector Stroke Line Join", PropertyValueType.OneD, 1),
      P("Miter Limit", "ADBE Vector Stroke Miter Limit", PropertyValueType.OneD, 4),
      new FakeGroup("Dashes", "ADBE Vector Stroke Dashes", []),
    ]),
  "ADBE Vector Stroke Dash 1": () => P("Dash", "ADBE Vector Stroke Dash 1", PropertyValueType.OneD, 10),
  "ADBE Vector Stroke Gap 1": () => P("Gap", "ADBE Vector Stroke Gap 1", PropertyValueType.OneD, 10),
  "ADBE Vector Stroke Dash 2": () => P("Dash 2", "ADBE Vector Stroke Dash 2", PropertyValueType.OneD, 10),
  "ADBE Vector Stroke Gap 2": () => P("Gap 2", "ADBE Vector Stroke Gap 2", PropertyValueType.OneD, 10),
  "ADBE Vector Stroke Dash 3": () => P("Dash 3", "ADBE Vector Stroke Dash 3", PropertyValueType.OneD, 10),
  "ADBE Vector Stroke Gap 3": () => P("Gap 3", "ADBE Vector Stroke Gap 3", PropertyValueType.OneD, 10),
  "ADBE Vector Stroke Offset": () => P("Offset", "ADBE Vector Stroke Offset", PropertyValueType.OneD, 0),
  // path operators
  "ADBE Vector Filter - Merge": (n) => new FakeGroup(`Merge Paths ${n}`, "ADBE Vector Filter - Merge", [P("Mode", "ADBE Vector Merge Type", PropertyValueType.OneD, 1)]),
  "ADBE Vector Filter - RC": (n) => new FakeGroup(`Round Corners ${n}`, "ADBE Vector Filter - RC", [P("Radius", "ADBE Vector RoundCorner Radius", PropertyValueType.OneD, 10)]),
  "ADBE Vector Filter - Zigzag": (n) =>
    new FakeGroup(`Zig Zag ${n}`, "ADBE Vector Filter - Zigzag", [
      P("Size", "ADBE Vector Zigzag Size", PropertyValueType.OneD, 10),
      P("Ridges per segment", "ADBE Vector Zigzag Detail", PropertyValueType.OneD, 5),
      P("Points", "ADBE Vector Zigzag Points", PropertyValueType.OneD, 2),
    ]),
  "ADBE Vector Filter - PB": (n) => new FakeGroup(`Pucker & Bloat ${n}`, "ADBE Vector Filter - PB", [P("Amount", "ADBE Vector PuckerBloat Amount", PropertyValueType.OneD, 10)]),
  "ADBE Vector Filter - Twist": (n) =>
    new FakeGroup(`Twist ${n}`, "ADBE Vector Filter - Twist", [
      P("Angle", "ADBE Vector Twist Angle", PropertyValueType.OneD, 0),
      P("Center", "ADBE Vector Twist Center", PropertyValueType.TwoD, [0, 0]),
    ]),
  "ADBE Vector Filter - Roughen": (n) =>
    new FakeGroup(`Wiggle Paths ${n}`, "ADBE Vector Filter - Roughen", [
      P("Size", "ADBE Vector Roughen Size", PropertyValueType.OneD, 10),
      P("Detail", "ADBE Vector Roughen Detail", PropertyValueType.OneD, 2),
      P("Points", "ADBE Vector Roughen Points", PropertyValueType.OneD, 2),
      P("Wiggles/Second", "ADBE Vector Temporal Freq", PropertyValueType.OneD, 2),
      P("Correlation", "ADBE Vector Correlation", PropertyValueType.OneD, 50),
      P("Temporal Phase", "ADBE Vector Temporal Phase", PropertyValueType.OneD, 0),
      P("Spatial Phase", "ADBE Vector Spatial Phase", PropertyValueType.OneD, 0),
      P("Random Seed", "ADBE Vector Random Seed", PropertyValueType.OneD, 0),
    ]),
  "ADBE Vector Filter - Wiggler": (n) =>
    new FakeGroup(`Wiggle Transform ${n}`, "ADBE Vector Filter - Wiggler", [
      P("Wiggles/Second", "ADBE Vector Xform Temporal Freq", PropertyValueType.OneD, 2),
      P("Correlation", "ADBE Vector Correlation", PropertyValueType.OneD, 50),
      P("Temporal Phase", "ADBE Vector Temporal Phase", PropertyValueType.OneD, 0),
      P("Spatial Phase", "ADBE Vector Spatial Phase", PropertyValueType.OneD, 0),
      P("Random Seed", "ADBE Vector Random Seed", PropertyValueType.OneD, 0),
      new FakeGroup("Transform", "ADBE Vector Wiggler Transform", [
        P("Position", "ADBE Vector Wiggler Position", PropertyValueType.TwoD, [10, 10]),
        P("Scale", "ADBE Vector Wiggler Scale", PropertyValueType.TwoD, [10, 10]),
        P("Rotation", "ADBE Vector Wiggler Rotation", PropertyValueType.OneD, 0),
      ]),
    ]),
};

function cloneNode(n: any): any {
  if (n instanceof FakeGroup) {
    const g: any = new FakeGroup(n.name, n.matchName, n.props.map(cloneNode), n.propertyType === PropertyType.INDEXED_GROUP);
    g.enabled = n.enabled;
    return g;
  }
  const p: any = new FakeProperty(n.name, n.matchName, n.propertyValueType, Array.isArray(n.staticValue) ? [...n.staticValue] : n.staticValue);
  if (n.propertyParameters) p.propertyParameters = n.propertyParameters;
  return p;
}

const proto = FakeGroup.prototype as any;
const saved = { addProperty: proto.addProperty, canAddProperty: proto.canAddProperty, moveTo: proto.moveTo, duplicate: proto.duplicate };
const canHold = (g: any) => g.propertyType === PropertyType.INDEXED_GROUP || g.matchName === "ADBE Vector Stroke Dashes";

beforeAll(() => {
  proto.addProperty = function (matchName: string) {
    const make = FACTORY[matchName];
    if (!make) return saved.addProperty.call(this, matchName);
    if (!canHold(this)) throw new Error(`Can't add ${matchName} to ${this.name}`);
    const made = make(this.props.filter((p: any) => p.matchName === matchName).length + 1);
    made.parentProperty = this;
    this.props.push(made);
    return made;
  };
  proto.canAddProperty = function (matchName: string) {
    return canHold(this) && Boolean(FACTORY[matchName]);
  };
  proto.moveTo = function (index: number) {
    const parent = this.parentProperty;
    parent.props.splice(parent.props.indexOf(this), 1);
    parent.props.splice(index - 1, 0, this);
  };
  proto.duplicate = function () {
    const parent = this.parentProperty;
    const copy = cloneNode(this);
    copy.parentProperty = parent;
    const at = parent.props.indexOf(this);
    parent.props.splice(opts.dupBefore ? at : at + 1, 0, copy);
    if (opts.dupUnlocatable) {
      return {
        get propertyIndex(): number {
          throw new Error("Object is invalid");
        },
      };
    }
    return copy;
  };
  Object.defineProperty(proto, "propertyIndex", {
    configurable: true,
    get(this: any) {
      return this.parentProperty ? this.parentProperty.props.indexOf(this) + 1 : 1;
    },
  });
});
afterAll(() => {
  proto.addProperty = saved.addProperty;
  proto.canAddProperty = saved.canAddProperty;
  proto.moveTo = saved.moveTo;
  proto.duplicate = saved.duplicate;
  delete proto.propertyIndex;
});
afterEach(() => {
  Object.assign(opts, { dropTaper: false, dropMiterLimit: false, noStages: false, noLabels: false, dupBefore: false, dupUnlocatable: false });
});

/** A comp with a solid "Plate" (indexed Effects group) and a second layer "Matte". */
function effectScene() {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const matte = comp.layers.addSolid([1, 1, 1], "Matte", 640, 360, 1, 4);
  const plate = comp.layers.addSolid([0, 0, 0], "Plate", 640, 360, 1, 4);
  for (const l of [matte, plate]) {
    const props = l.group.props;
    const i = props.findIndex((p: any) => p.matchName === "ADBE Effect Parade");
    const g = new FakeGroup("Effects", "ADBE Effect Parade", [], true);
    g.parentProperty = l.group;
    props[i] = g;
  }
  const parade = plate.property("ADBE Effect Parade") as any;
  return { project, comp, plate, matte, parade };
}

const names = (parade: any) => parade.props.map((p: any) => p.name);

// ---------- schemas ----------

describe("schemas", () => {
  const base = { comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, expect: expectArg };

  it("ae_set_effect takes move_to or duplicate, not both, and counts them as a change", () => {
    expect(AeSetEffectSchema.safeParse({ ...base, move_to: 2 }).success).toBe(true);
    expect(AeSetEffectSchema.safeParse({ ...base, duplicate: 3 }).success).toBe(true);
    expect(AeSetEffectSchema.safeParse({ ...base, move_to: 2, duplicate: 1 }).success).toBe(false);
    expect(AeSetEffectSchema.safeParse({ ...base, duplicate: 21 }).success).toBe(false);
    expect(AeSetEffectSchema.safeParse({ ...base, move_to: 0 }).success).toBe(false);
    expect(AeSetEffectSchema.safeParse(base).success).toBe(false);
  });

  it("effect params accept labels and {layer, stage}", () => {
    const ok = AeSetEffectSchema.safeParse({
      ...base,
      params: [
        { param: "Blur Dimensions", value: "Horizontal" },
        { param: "Take Matte From Layer", value: { layer: { name: "Matte" }, stage: "masks" } },
        { param: 1, value: { layer: 0 } },
      ],
    });
    expect(ok.success).toBe(true);
    expect(AeSetEffectSchema.safeParse({ ...base, params: [{ param: 1, value: { layer: { name: "M" }, stage: "everything" } }] }).success).toBe(false);
    expect(AeAddEffectSchema.safeParse({ comp_id: 1, layer: { name: "Plate" }, effect: "ADBE Gaussian Blur 2", params: [{ param: 2, value: "Vertical" }], expect: expectArg }).success).toBe(true);
  });

  it("ae_shape takes stroke details, gradients, fill rule, duplicate and move", () => {
    const ok = AeShapeSchema.safeParse({
      comp_id: 1,
      layer: { index: 1 },
      add: [
        {
          type: "rect",
          size: [100, 50],
          stroke: { color: [1, 1, 1], width: 4, line_cap: "round", line_join: "bevel", miter_limit: 6, dashes: [{ dash: 10, gap: 5 }], dash_offset: 2, taper: { start_length: 20 }, wave: { amount: 3 } },
          fill: { color: [1, 0, 0], rule: "even_odd" },
        },
        { type: "ellipse", size: [50, 50], gradient_fill: { type: "radial", start_point: [0, 0], end_point: [50, 0], highlight_length: 10 }, gradient_stroke: { type: "linear", width: 3, dashes: [{ dash: 1, gap: 1 }] } },
      ],
      expect: expectArg,
    });
    expect(ok.success).toBe(true);
    expect(AeShapeSchema.safeParse({ comp_id: 1, layer: { index: 1 }, duplicate: [{ name: "A", count: 2 }], expect: expectArg }).success).toBe(true);
    expect(AeShapeSchema.safeParse({ comp_id: 1, layer: { index: 1 }, move: [{ name: "A", to: 1 }], expect: expectArg }).success).toBe(true);
  });

  it("ae_shape refuses contradictory specs", () => {
    const rect = { type: "rect", size: [10, 10] };
    const parse = (o: object) => AeShapeSchema.safeParse({ comp_id: 1, layer: { index: 1 }, expect: expectArg, ...o }).success;
    expect(parse({ add: [{ ...rect, fill: { color: [1, 0, 0] }, gradient_fill: { type: "linear" } }] })).toBe(false);
    expect(parse({ add: [{ ...rect, stroke: { color: [1, 0, 0], width: 1 }, gradient_stroke: { type: "linear", width: 1 } }] })).toBe(false);
    expect(parse({ add: [{ ...rect, stroke: { color: [1, 0, 0], width: 1, dash_offset: 3 } }] })).toBe(false);
    expect(parse({ add: [{ ...rect, stroke: { color: [1, 0, 0], width: 1, dashes: [] } }] })).toBe(false);
    expect(parse({ duplicate: [{ index: 1 }], remove: [{ index: 2 }] })).toBe(false);
    expect(parse({ duplicate: [{ index: 1 }], move: [{ index: 2, to: 1 }] })).toBe(false);
    expect(parse({ move: [{ index: 2, to: 1 }], remove: [{ index: 3 }] })).toBe(false);
    expect(parse({})).toBe(false);
  });

  it("ae_path_operator takes the new operators and only with their own settings", () => {
    const parse = (o: object) => AePathOperatorSchema.safeParse({ comp_id: 1, layer: { index: 1 }, group: { index: 1 }, expect: expectArg, ...o }).success;
    expect(parse({ operator: "merge", merge: { mode: "subtract" } })).toBe(true);
    expect(parse({ operator: "round_corners", round_corners: { radius: 12 } })).toBe(true);
    expect(parse({ operator: "zig_zag", zig_zag: { size: 5, ridges_per_segment: 4, points: "smooth" } })).toBe(true);
    expect(parse({ operator: "pucker_bloat", pucker_bloat: { amount: -30 } })).toBe(true);
    expect(parse({ operator: "twist", twist: { angle: 90, center: [0, 0] } })).toBe(true);
    expect(parse({ operator: "wiggle_paths", wiggle_paths: { size: 8, detail: 3, random_seed: 7 } })).toBe(true);
    expect(parse({ operator: "wiggle_transform", wiggle_transform: { wiggles_per_second: 3, transform: { position: [5, 5] } } })).toBe(true);
    expect(parse({ operator: "merge", round_corners: { radius: 1 } })).toBe(false);
    expect(parse({ operator: "merge", merge: { mode: "xor" } })).toBe(false);
    expect(parse({ operator: "pucker_bloat", pucker_bloat: { amount: 500 } })).toBe(false);
    expect(parse({ operator: "trim", trim: { start: 5 } })).toBe(true);
  });

  it("the edited tools still end with the safety guidance and describe the new features", () => {
    for (const n of ["ae_add_effect", "ae_set_effect", "ae_apply_preset"]) expect(effectTool(n).description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(shapeTool.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(operatorTool.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(effectTool("ae_set_effect").description).toMatch(/move_to/);
    expect(effectTool("ae_set_effect").description).toMatch(/26\.5/);
    expect(effectTool("ae_add_effect").description).toMatch(/ADBE Layer Styles/);
    expect(effectTool("ae_add_effect").description).toMatch(/not yet probed/);
    expect(effectTool("ae_apply_preset").description).toMatch(/Layer Styles/);
    expect(shapeTool.description).toMatch(/gradient/);
    expect(operatorTool.description).toMatch(/Merge Paths/);
  });
});

// ---------- pure logic ----------

describe("pure logic", () => {
  it("reorderStack and applyMoves move one item at a time", () => {
    expect(reorderStack(["a", "b", "c", "d"], 1, 3)).toEqual(["b", "c", "a", "d"]);
    expect(reorderStack(["a", "b", "c", "d"], 4, 1)).toEqual(["d", "a", "b", "c"]);
    expect(reorderStack(["a", "b"], 5, 1)).toEqual(["a", "b"]);
  });

  it("applyMoves gives the order the host will produce", () => {
    // [A,B,C] -> move 3 to 1 -> [C,A,B] -> move 2 to 3 -> [C,B,A]
    expect(applyMoves(["A", "B", "C"], [{ from: 3, to: 1 }, { from: 2, to: 3 }])).toEqual(["C", "B", "A"]);
  });

  const snap = (value: unknown, extra: object = {}) => ({
    index: 1,
    name: "E",
    matchName: "M",
    enabled: true,
    params: [{ index: 1, name: "Dims", matchName: "M-1", path: ["Dims"], type: "1d", settable: true, value, ...extra }],
  });

  it("paramMismatches checks a label through the number the host wrote, and a stage through the read-back", () => {
    const written = [{ param: "Dims", how: "value", resolved_value: 2, label: "Horizontal" }];
    expect(paramMismatches(snap(2), [{ param: "Dims", value: "Horizontal" }], written)).toEqual([]);
    expect(paramMismatches(snap(1), [{ param: "Dims", value: "Horizontal" }], written)[0].path).toBe("params.Dims");
    // the host said nothing about what it wrote
    expect(paramMismatches(snap(2), [{ param: "Dims", value: "Horizontal" }], undefined)[0].message).toMatch(/did not report/);
    const staged = [{ param: "Dims", how: "layer_and_stage", resolved_value: 2, stage: "masks" }];
    const pick = [{ param: "Dims", value: { layer: { name: "Matte" }, stage: "masks" as const } }];
    expect(paramMismatches(snap(2, { input_stage: "masks" }), pick, staged)).toEqual([]);
    expect(paramMismatches(snap(2, { input_stage: "source" }), pick, staged)[0].path).toBe("params.Dims.input_stage");
    expect(paramMismatches(snap(2), pick, staged)[0].message).toMatch(/not verified/);
  });

  it("stackMismatches compares the whole order after a move and counts the copies", () => {
    const fx = (name: string, index: number) => ({ index, name, matchName: `M-${name}`, enabled: true, params: [] });
    const before = { effects: [fx("A", 1), fx("B", 2), fx("C", 3)] };
    const moved = { effects: [fx("B", 1), fx("C", 2), fx("A", 3)] };
    expect(stackMismatches({ move_to: 3 }, before, moved, { move: { from: 1, to: 3 } })).toEqual([]);
    expect(stackMismatches({ move_to: 3 }, before, before, { move: { from: 1, to: 3 } })[0].path).toMatch(/^effects.order/);
    // a rename in the same call changes the key of the moved effect
    const renamed = { effects: [fx("B", 1), fx("C", 2), { ...fx("A", 3), name: "Z" }] };
    expect(stackMismatches({ move_to: 3, name: "Z" }, before, renamed, { move: { from: 1, to: 3 } })).toEqual([]);
    // a list cut at 100 effects cannot show a move past the cut: no false order mismatch
    const cut = { effects: [fx("B", 1), fx("C", 2)], truncated: true };
    expect(stackMismatches({ move_to: 110 }, { ...before, truncated: true }, cut, { move: { from: 1, to: 110 } })).toEqual([]);
    // a move that starts past the cut and ends inside the list shifts the listed part: not checked, no false mismatch
    const shiftedIn = { effects: [fx("A", 1), fx("B", 2), fx("E110", 3)], truncated: true };
    expect(stackMismatches({ move_to: 3 }, { effects: [fx("A", 1), fx("B", 2), fx("C", 3)], truncated: true }, shiftedIn, { move: { from: 110, to: 3 } })).toEqual([]);
    // a move with both ends inside the listed part is still checked, on the listed part
    const cutBefore = { ...before, truncated: true };
    expect(stackMismatches({ move_to: 3 }, cutBefore, { ...moved, truncated: true }, { move: { from: 1, to: 3 } })).toEqual([]);
    expect(stackMismatches({ move_to: 3 }, cutBefore, { ...before, truncated: true }, { move: { from: 1, to: 3 } })[0].path).toMatch(/^effects.order/);
    // the count check on a duplicate only guards whole lists (the host never duplicates past 100, so this is defensive)
    expect(stackMismatches({ duplicate: 1 }, cutBefore, cut, { duplicates: [], duplicate_located: true })).toEqual([]);
    const dup = { effects: [fx("A", 1), fx("A", 2), fx("B", 3), fx("C", 4)] };
    expect(stackMismatches({ duplicate: 1 }, before, dup, { duplicates: [{ index: 2, matchName: "M-A" }], duplicate_located: true })).toEqual([]);
    expect(stackMismatches({ duplicate: 2 }, before, dup, { duplicates: [{ index: 2, matchName: "M-A" }], duplicate_located: true })[0].path).toBe("effects.length");
    expect(stackMismatches({ duplicate: 1 }, before, dup, { duplicates: [{ index: 3, matchName: "M-A" }], duplicate_located: true })[0].message).toMatch(/not at the index/);
    expect(stackMismatches({ duplicate: 1 }, before, dup, { duplicate_located: false, duplicate_made: 1 }).some((m) => m.path === "duplicates")).toBe(true);
  });

  it("shapeMismatches checks stroke details, gradients, copies and the new order", () => {
    const stroke = {
      name: "Stroke 1", matchName: "ADBE Vector Graphic - Stroke", kind: "stroke", width: 4, line_cap: 2, line_join: 3, miter_limit: 6,
      dashes: [{ matchName: "ADBE Vector Stroke Dash 1", value: 10 }, { matchName: "ADBE Vector Stroke Gap 1", value: 5 }, { matchName: "ADBE Vector Stroke Offset", value: 2 }],
      taper: { start_length: 20 }, wave: { amount: 3 },
    };
    const group = (items: object[]) => ({ index: 1, name: "Card", matchName: "ADBE Vector Group", kind: "group", items: [{ kind: "rect", size: [100, 50] }, ...items] });
    const spec: any = AeShapeSchema.parse({
      comp_id: 1, layer: { index: 1 }, expect: expectArg,
      add: [{ type: "rect", name: "Card", size: [100, 50], stroke: { color: [1, 1, 1], width: 4, line_cap: "round", line_join: "bevel", miter_limit: 6, dashes: [{ dash: 10, gap: 5 }], dash_offset: 2, taper: { start_length: 20 }, wave: { amount: 3 } } }],
    }).add;
    const empty = { count: 0, contents: [], truncated: false };
    const after = (items: object[]) => ({ count: 1, contents: [group(items)], truncated: false });
    expect(shapeMismatches(spec, empty, after([stroke]), { added: [{ index: 1, name: "Card" }] })).toEqual([]);
    const bad = shapeMismatches(spec, empty, after([{ ...stroke, line_cap: 1, taper: { start_length: 0 } }]), { added: [{ index: 1, name: "Card" }] });
    expect(bad.map((m) => m.path).sort()).toEqual(["Card.stroke.line_cap", "Card.stroke.taper.start_length"]);

    const g: any = AeShapeSchema.parse({
      comp_id: 1, layer: { index: 1 }, expect: expectArg,
      add: [{ type: "ellipse", name: "Card", size: [10, 10], gradient_fill: { type: "radial", start_point: [0, 0], end_point: [10, 0] }, gradient_stroke: { type: "linear", width: 3 } }],
    }).add;
    const gf = { kind: "gradient_fill", gradient_type: 2, start_point: [0, 0], end_point: [10, 0] };
    const gs = { kind: "gradient_stroke", gradient_type: 1, width: 3 };
    const gAfter = { count: 1, contents: [{ index: 1, name: "Card", kind: "group", items: [{ kind: "ellipse", size: [10, 10] }, gf, gs] }], truncated: false };
    expect(shapeMismatches(g, empty, gAfter, { added: [{ index: 1, name: "Card" }] })).toEqual([]);
    const gWrong = { ...gAfter, contents: [{ ...gAfter.contents[0], items: [gAfter.contents[0].items[0], { ...gf, gradient_type: 1 }, gs] }] };
    expect(shapeMismatches(g, empty, gWrong, { added: [{ index: 1, name: "Card" }] })[0].path).toBe("Card.gradient_fill.type");

    const item = (i: number, name: string, matchName = "ADBE Vector Group") => ({ index: i, name, matchName, kind: "group" });
    const before2 = { count: 2, contents: [item(1, "A"), item(2, "B")], truncated: false };
    const dupAfter = { count: 3, contents: [item(1, "A"), item(2, "A 2"), item(3, "B")], truncated: false };
    const rec = [{ source_index: 1, copies: [{ index: 2, name: "A 2" }], requested: 1 }];
    expect(shapeMismatches([], before2, dupAfter, { duplicated: rec, duplicate_located: true })).toEqual([]);
    expect(shapeMismatches([], before2, { ...dupAfter, count: 2 }, { duplicated: rec, duplicate_located: true }).some((m) => m.path === "count")).toBe(true);
    const moveAfter = { count: 2, contents: [item(1, "B"), item(2, "A")], truncated: false };
    expect(shapeMismatches([], before2, moveAfter, { moved: [{ from: 2, to: 1 }] })).toEqual([]);
    expect(shapeMismatches([], before2, before2, { moved: [{ from: 2, to: 1 }] })[0].path).toMatch(/^contents.order/);
  });

  it("genericMismatches reads each new operator's settings back", () => {
    const args: any = AePathOperatorSchema.parse({ comp_id: 1, layer: { index: 1 }, group: { index: 1 }, expect: expectArg, operator: "zig_zag", zig_zag: { size: 7, ridges_per_segment: 3, points: "smooth" } });
    const m: any[] = [];
    genericMismatches(args, { index: 2, name: "Zig Zag 1", matchName: "ADBE Vector Filter - Zigzag", kind: "zig_zag", size: 7, ridges_per_segment: 3, points: 2 }, "items[2]", m);
    expect(m).toEqual([]);
    genericMismatches(args, { index: 2, name: "Zig Zag 1", matchName: "ADBE Vector Filter - Zigzag", kind: "zig_zag", size: 7, ridges_per_segment: 3, points: 1 }, "items[2]", m);
    expect(m[0].path).toBe("items[2].points");
  });
});

// ---------- guarded-write flows through a fake bridge ----------

describe("flows", () => {
  const fxList = (names_: string[]) => ({
    effects: names_.map((n, i) => ({ index: i + 1, name: n, matchName: `M-${n}`, enabled: true, params: [] })),
  });

  it("ae_set_effect move_to reads, writes, reads back and checks the new order", async () => {
    const { ctx, calls } = fakeAe({
      listLayerEffects: [fxList(["A", "B", "C"]), fxList(["B", "C", "A"])],
      setEffect: [{ index: 3, name: "A", matchName: "M-A", enabled: true, params_set: [], move: { from: 1, to: 3, matched: true }, expression_warnings: [{ layer: "Plate", property: "Opacity", expression: "effect(2)(1)" }] }],
    });
    const args = AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, move_to: 3, expect: expectArg });
    const out: any = await effectTool("ae_set_effect").handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "listLayerEffects", "setEffect", "listLayerEffects"]);
    expect(calls[2].script).toContain('"move_to":3');
    expect(out.receipt.matches).toBe(true);
    expect(out.effect.name).toBe("A");
    expect(out.stack.map((e: any) => e.name)).toEqual(["B", "C", "A"]);
    expect(out.expression_warnings).toHaveLength(1);
  });

  // a 120-effect layer: the read-backs list only the first 100
  const longList = (swap?: boolean | "shiftedPast") => {
    const l: any = fxList(Array.from({ length: 100 }, (_, i) => `E${i + 1}`));
    if (swap === true) l.effects = [l.effects[1], l.effects[0], ...l.effects.slice(2)].map((e: any, i: number) => ({ ...e, index: i + 1 }));
    if (swap === "shiftedPast") {
      // effect 5 moved to slot 110: the listed part loses it and gains E101 at the end
      l.effects = [...l.effects.slice(0, 4), ...l.effects.slice(5), { ...l.effects[0], name: "E101", matchName: "M-E101" }].map((e: any, i: number) => ({ ...e, index: i + 1 }));
    }
    l.truncated = true;
    return l;
  };

  it("ae_set_effect on an effect past the 100 listed skips the enabled, name and parameter read-back", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [longList(), longList()],
      setEffect: [{ index: 110, name: "Soft", matchName: "M-E110", enabled: false, params_set: [{ param: "1", how: "value" }] }],
    });
    const args = AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 110 }, enabled: false, name: "Soft", params: [{ param: 1, value: 5 }], expect: expectArg });
    const out: any = await effectTool("ae_set_effect").handler(args, ctx);
    expect(out.receipt.mismatches).toEqual([]);
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_set_effect on a cut list still flags a move inside the listed part that did not happen, and lets a move past the cut pass", async () => {
    const inside = fakeAe({
      listLayerEffects: [longList(), longList()],
      setEffect: [{ index: 2, name: "E1", matchName: "M-E1", enabled: true, params_set: [], move: { from: 1, to: 2, matched: false } }],
    });
    const bad: any = await effectTool("ae_set_effect").handler(AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, move_to: 2, expect: expectArg }), inside.ctx);
    expect(bad.receipt.matches).toBe(false);
    expect(bad.receipt.mismatches[0].path).toMatch(/^effects.order/);
    const done = fakeAe({
      listLayerEffects: [longList(), longList(true)],
      setEffect: [{ index: 2, name: "E1", matchName: "M-E1", enabled: true, params_set: [], move: { from: 1, to: 2, matched: true } }],
    });
    const ok: any = await effectTool("ae_set_effect").handler(AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, move_to: 2, expect: expectArg }), done.ctx);
    expect(ok.receipt.matches).toBe(true);
    const past = fakeAe({
      listLayerEffects: [longList(), longList("shiftedPast")],
      setEffect: [{ index: 110, name: "E5", matchName: "M-E5", enabled: true, params_set: [], move: { from: 5, to: 110, matched: true } }],
    });
    const out: any = await effectTool("ae_set_effect").handler(AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 5 }, move_to: 110, expect: expectArg }), past.ctx);
    expect(out.receipt.matches).toBe(true);
    expect(effectTool("ae_set_effect").description).toMatch(/not order-checked/);
  });

  it("ae_set_effect flags a move that did not happen", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [fxList(["A", "B", "C"]), fxList(["A", "B", "C"])],
      setEffect: [{ index: 3, name: "A", matchName: "M-A", enabled: true, params_set: [], move: { from: 1, to: 3, matched: false } }],
    });
    const out: any = await effectTool("ae_set_effect").handler(AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, move_to: 3, expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].path).toMatch(/^effects.order/);
  });

  it("ae_set_effect duplicate checks the copy count", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [fxList(["A", "B"]), fxList(["A", "A", "A", "B"])],
      setEffect: [{ index: 1, name: "A", matchName: "M-A", enabled: true, params_set: [], duplicates: [{ index: 2, name: "A", matchName: "M-A" }, { index: 3, name: "A", matchName: "M-A" }], duplicate_made: 2, duplicate_located: true }],
    });
    const out: any = await effectTool("ae_set_effect").handler(AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, duplicate: 2, expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(true);
    expect(out.duplicates).toHaveLength(2);
  });

  it("ae_set_effect no-op reports no_op and passes the receipt", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [fxList(["A", "B"]), fxList(["A", "B"])],
      setEffect: [{ index: 1, name: "A", matchName: "M-A", enabled: true, params_set: [], no_op: true, note: "Nothing to change" }],
    });
    const out: any = await effectTool("ae_set_effect").handler(AeSetEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: { index: 1 }, move_to: 1, expect: expectArg }), ctx);
    expect(out.no_op).toBe(true);
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_add_effect with a layer style name checks the host's report, not the effect count", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [fxList(["A"]), { ...fxList(["A"]), layer_styles: [{ slot: "dropShadow/enabled", enabled: true }] }],
      addEffect: [{ comp_id: 1, layer_id: 7, layer_style: true, style: "dropShadow", slot: "dropShadow/enabled" }],
    });
    const out: any = await effectTool("ae_add_effect").handler(AeAddEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: "dropShadow", expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(true);
    expect(out.layer_style.style).toBe("dropShadow");
  });

  it("ae_add_effect with a layer style fails the receipt when the read-back does not show the slot enabled", async () => {
    const { ctx } = fakeAe({
      listLayerEffects: [fxList(["A"]), { ...fxList(["A"]), layer_styles: [{ slot: "dropShadow/enabled", enabled: false }] }],
      addEffect: [{ comp_id: 1, layer_id: 7, layer_style: true, style: "dropShadow", slot: "dropShadow/enabled" }],
    });
    const out: any = await effectTool("ae_add_effect").handler(AeAddEffectSchema.parse({ comp_id: 1, layer: { name: "Plate" }, effect: "dropShadow", expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
  });

  it("ae_shape passes duplicate and move to the host and checks the result", async () => {
    const item = (i: number, name: string) => ({ index: i, name, matchName: "ADBE Vector Group", kind: "group" });
    const { ctx, calls } = fakeAe({
      shapeContents: [
        { count: 2, contents: [item(1, "A"), item(2, "B")], truncated: false },
        { count: 3, contents: [item(1, "A"), item(2, "A"), item(3, "B")], truncated: false },
      ],
      shapeEdit: [{ removed: [], added: [], count: 3, duplicated: [{ source_index: 1, source_name: "A", copies: [{ index: 2, name: "A" }], requested: 1 }], duplicate_located: true }],
    });
    const args = AeShapeSchema.parse({ comp_id: 1, layer: { index: 1 }, duplicate: [{ name: "A" }], expect: expectArg });
    const out: any = await shapeTool.handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "shapeContents", "shapeEdit", "shapeContents"]);
    expect(calls[2].script).toContain('"duplicate"');
    expect(out.receipt.matches).toBe(true);
    expect(out.duplicated).toHaveLength(1);
  });

  it("ae_path_operator merge flows through the same checks", async () => {
    const before = { group: { index: 1, name: "G" }, count: 1, truncated: false, items: [] };
    const item = { index: 2, name: "Merge Paths 1", matchName: "ADBE Vector Filter - Merge", kind: "merge", mode: 3 };
    const { ctx, calls } = fakeAe({
      pathsOperators: [{ ...before, count: 1 }, { ...before, count: 2, items: [item] }],
      pathsOperator: [{ operator: "merge", added: [{ index: 2, name: "Merge Paths 1", matchName: "ADBE Vector Filter - Merge" }] }],
    });
    const args = AePathOperatorSchema.parse({ comp_id: 1, layer: { index: 1 }, group: { index: 1 }, operator: "merge", merge: { mode: "subtract" }, expect: expectArg });
    const out: any = await operatorTool.handler(args, ctx);
    expect(calls[2].script).toContain('"merge":{"mode":"subtract"}');
    expect(out.receipt.matches).toBe(true);
    const wrong = fakeAe({
      pathsOperators: [{ ...before }, { ...before, count: 2, items: [{ ...item, mode: 1 }] }],
      pathsOperator: [{ operator: "merge", added: [{ index: 2, name: "Merge Paths 1", matchName: "ADBE Vector Filter - Merge" }] }],
    });
    const bad: any = await operatorTool.handler(args, wrong.ctx);
    expect(bad.receipt.matches).toBe(false);
    expect(bad.receipt.mismatches[0].path).toBe("items[2].mode");
  });
});

// ---------- effects.jsx under node:vm ----------

describe("effects.jsx", () => {
  const set = (A: any, comp: any, layer: any, o: object) => A.setEffect({ comp_id: comp.id, layer: { id: layer.id }, effect: { index: 1 }, expect: GUARD, ...o });
  const add = (A: any, comp: any, layer: any, effect: string, o: object = {}) => A.addEffect({ comp_id: comp.id, layer: { id: layer.id }, effect, expect: GUARD, ...o });

  it("lists popup labels and the input stage of layer pickers", () => {
    const { project, comp, plate } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    add(A, comp, plate, "ADBE Set Matte3");
    const read = A.listLayerEffects({ comp_id: comp.id, layer: { id: plate.id } });
    const dims = read.effects[0].params.find((p: any) => p.name === "Blur Dimensions");
    expect(dims.options).toEqual(["Horizontal and Vertical", "Horizontal", "Vertical"]);
    expect(dims.value_text).toBe("Horizontal and Vertical");
    const slider = read.effects[0].params.find((p: any) => p.name === "Blurriness");
    expect(slider.options).toBeUndefined();
    const pick = read.effects[1].params.find((p: any) => p.name === "Take Matte From Layer");
    expect(pick).toMatchObject({ type: "layer", input_stage_supported: true, input_layer: 0, input_stage: "source" });
  });

  it("reports input_stage_supported false below 26.5 and no labels where AE has none", () => {
    opts.noStages = true;
    opts.noLabels = true;
    const { project, comp, plate } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    add(A, comp, plate, "ADBE Set Matte3");
    const read = A.listLayerEffects({ comp_id: comp.id, layer: { id: plate.id } });
    expect(read.effects[0].params.find((p: any) => p.name === "Blur Dimensions").options).toBeUndefined();
    expect(read.effects[1].params.find((p: any) => p.name === "Take Matte From Layer").input_stage_supported).toBe(false);
  });

  it("sets a popup by label and reports the number it wrote", () => {
    const { project, comp, plate } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    const out = set(A, comp, plate, { params: [{ param: "Blur Dimensions", value: "  vertical " }, { param: "Blurriness", value: 12 }] });
    expect(out.params_set[0]).toMatchObject({ how: "value", resolved_value: 3, label: "  vertical " });
    expect(out.params_set[1]).toEqual({ param: "Blurriness", how: "value" });
    expect((plate.property("ADBE Effect Parade") as any).property(1).property("ADBE Gaussian Blur 2-0002").value).toBe(3);
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
  });

  it("refuses a bad label, a label on a slider, and a popup without labels, before any undo group", () => {
    const { project, comp, plate } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    const begun = undo.begun;
    expect(() => set(A, comp, plate, { params: [{ param: "Blurriness", value: 5 }, { param: "Blur Dimensions", value: "Diagonal" }] })).toThrow(/No menu item "Diagonal".*Horizontal/);
    expect(() => set(A, comp, plate, { params: [{ param: "Blurriness", value: "high" }] })).toThrow(/menu labels/);
    expect(undo.begun).toBe(begun);
    // nothing was written by the call that failed on its second parameter
    expect((plate.property("ADBE Effect Parade") as any).property(1).property("ADBE Gaussian Blur 2-0001").value).toBe(0);
    opts.noLabels = true;
    const second = effectScene();
    const host2 = loadHost(second.project, ["effects.jsx"]);
    add(host2.A, second.comp, second.plate, "ADBE Gaussian Blur 2");
    expect(() => set(host2.A, second.comp, second.plate, { params: [{ param: "Blur Dimensions", value: "Vertical" }] })).toThrow(/reports no menu labels/);
  });

  it("picks an input layer and a stage on 26.5, reading the cycle-safe limit", () => {
    const { project, comp, plate, matte } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Set Matte3");
    const out = set(A, comp, plate, { params: [{ param: "Take Matte From Layer", value: { layer: { name: "Matte" }, stage: "masks" } }] });
    const prop: any = (plate.property("ADBE Effect Parade") as any).property(1).property("ADBE Set Matte3-0001");
    expect(prop.pair).toEqual([matte.index, -2]);
    expect(out.params_set[0]).toMatchObject({ how: "layer_and_stage", resolved_value: matte.index, stage: "masks", cycle_safe_limit: 3 });
    const read = A.listLayerEffects({ comp_id: comp.id, layer: { id: plate.id } });
    expect(read.effects[0].params[0]).toMatchObject({ input_layer: matte.index, input_stage: "masks" });
    set(A, comp, plate, { params: [{ param: "Take Matte From Layer", value: { layer: { name: "Matte" }, stage: "effects" } }] });
    expect(prop.pair).toEqual([matte.index, -1]);
    set(A, comp, plate, { params: [{ param: "Take Matte From Layer", value: { layer: 0 } }] });
    expect(prop.staticValue).toBe(0);
  });

  it("refuses a stage below 26.5, a cycle, a stage without a layer and a locked layer", () => {
    const { project, comp, plate } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Set Matte3");
    const begun = undo.begun;
    const own = { param: 1, value: { layer: { id: plate.id }, stage: "effects" } };
    expect(() => set(A, comp, plate, { params: [own] })).toThrow(/cycle/);
    expect(() => set(A, comp, plate, { params: [{ param: 1, value: { layer: 0, stage: "masks" } }] })).toThrow(/needs a layer/);
    plate.locked = true;
    expect(() => set(A, comp, plate, { params: [{ param: 1, value: { layer: { name: "Matte" }, stage: "masks" } }] })).toThrow(/locked/);
    plate.locked = false;
    // the layer alone (no stage) is fine on a locked layer's older path: a plain pick
    expect(undo.begun).toBe(begun);
    opts.noStages = true;
    const old = effectScene();
    const oldHost = loadHost(old.project, ["effects.jsx"]);
    add(oldHost.A, old.comp, old.plate, "ADBE Set Matte3");
    expect(() => set(oldHost.A, old.comp, old.plate, { params: [{ param: 1, value: { layer: { name: "Matte" }, stage: "masks" } }] })).toThrow(/26\.5/);
    const plain = set(oldHost.A, old.comp, old.plate, { params: [{ param: 1, value: { layer: { name: "Matte" } } }] });
    expect(plain.params_set[0]).toMatchObject({ how: "value", resolved_value: old.matte.index });
  });

  it("reports an AE refusal of a stage (a cycle AE found itself) as bad_args", () => {
    const { project, comp, plate, matte } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Set Matte3");
    ((plate.property("ADBE Effect Parade") as any).property(1).property("ADBE Set Matte3-0001") as any).cycleLayer = matte.index;
    expect(() => set(A, comp, plate, { params: [{ param: 1, value: { layer: { name: "Matte" }, stage: "effects" } }] })).toThrow(/AE refused/);
  });

  it("does not compare the cycle-safe limit with the layer index, and undoes earlier changes when AE refuses a stage", () => {
    const { project, comp, plate, matte } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Set Matte3");
    const fx: any = (plate.property("ADBE Effect Parade") as any).property(1);
    const prop: any = fx.property("ADBE Set Matte3-0001");
    prop.safeLimit = 0;
    const ok = set(A, comp, plate, { params: [{ param: 1, value: { layer: { name: "Matte" }, stage: "masks" } }] });
    expect(prop.pair).toEqual([matte.index, -2]);
    expect(ok.params_set[0]).toMatchObject({ cycle_safe_limit: 0 });
    prop.pair = [0, 0];
    prop.safeLimit = 3;
    prop.cycleLayer = matte.index;
    const nameBefore = fx.name;
    expect(() => set(A, comp, plate, { enabled: false, name: "Renamed", params: [{ param: 1, value: { layer: { name: "Matte" }, stage: "effects" } }] })).toThrow(/AE refused/);
    expect(fx.enabled).toBe(true);
    expect(fx.name).toBe(nameBefore);
    expect(prop.pair).toEqual([0, 0]);
  });

  it("moves an effect and reports where it went", () => {
    const { project, comp, plate, parade } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    add(A, comp, plate, "ADBE Glo2");
    add(A, comp, plate, "ADBE Set Matte3");
    const begun = undo.begun;
    const out = set(A, comp, plate, { effect: { name: "Gaussian Blur" }, move_to: 3 });
    expect(names(parade)).toEqual(["Glow", "Set Matte", "Gaussian Blur"]);
    expect(out).toMatchObject({ index: 3, name: "Gaussian Blur", move: { from: 1, to: 3, matched: true } });
    expect(undo.begun).toBe(begun + 1);
    expect(undo.ended).toBe(begun + 1);
    const back = set(A, comp, plate, { effect: { index: 3 }, move_to: 1, name: "Blur A" });
    expect(names(parade)).toEqual(["Blur A", "Glow", "Set Matte"]);
    expect(back.index).toBe(1);
  });

  it("move_to the current place is a no-op with no undo group; bad positions and locks are refused first", () => {
    const { project, comp, plate, parade } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    add(A, comp, plate, "ADBE Glo2");
    const begun = undo.begun;
    const same = set(A, comp, plate, { effect: { index: 2 }, move_to: 2 });
    expect(same.no_op).toBe(true);
    expect(undo.begun).toBe(begun);
    expect(() => set(A, comp, plate, { move_to: 3 })).toThrow(/move_to must be/);
    expect(() => set(A, comp, plate, { move_to: 1.5 })).toThrow(/move_to must be/);
    expect(() => set(A, comp, plate, { move_to: 2, duplicate: 1 })).toThrow(/not both/);
    plate.locked = true;
    expect(() => set(A, comp, plate, { move_to: 2 })).toThrow(/locked/);
    plate.locked = false;
    expect(undo.begun).toBe(begun);
    expect(names(parade)).toEqual(["Gaussian Blur", "Glow"]);
  });

  it("duplicates an effect with its values, wherever AE puts the copies", () => {
    for (const before of [false, true]) {
      opts.dupBefore = before;
      const { project, comp, plate, parade } = effectScene();
      const { A, undo } = loadHost(project, ["effects.jsx"]);
      add(A, comp, plate, "ADBE Gaussian Blur 2");
      add(A, comp, plate, "ADBE Glo2");
      const begun = undo.begun;
      const out = set(A, comp, plate, { effect: { name: "Gaussian Blur" }, duplicate: 2, params: [{ param: "Blurriness", value: 30 }] });
      expect(parade.numProperties).toBe(4);
      expect(out.duplicate_located).toBe(true);
      expect(out.duplicate_made).toBe(2);
      expect(out.duplicates).toHaveLength(2);
      for (const d of out.duplicates) {
        const fx = parade.property(d.index);
        expect(fx.matchName).toBe("ADBE Gaussian Blur 2");
        expect(fx.property("ADBE Gaussian Blur 2-0001").value).toBe(30);
      }
      // the original is where the result says, and the Glow stays last
      expect(parade.property(out.index).matchName).toBe("ADBE Gaussian Blur 2");
      expect(parade.property(4).matchName).toBe("ADBE Glo2");
      expect(new Set([out.index, ...out.duplicates.map((d: any) => d.index)]).size).toBe(3);
      expect(undo.begun).toBe(begun + 1);
      expect(undo.ended).toBe(begun + 1);
    }
  });

  it("says so when AE does not report where a copy went", () => {
    opts.dupUnlocatable = true;
    const { project, comp, plate } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    const out = set(A, comp, plate, { duplicate: 3 });
    expect(out.duplicate_located).toBe(false);
    expect(out.duplicate_made).toBe(1);
    expect(out.duplicates).toEqual([]);
  });

  it("warns about expressions that read an effect by position, on this layer and others", () => {
    const { project, comp, plate, matte } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    add(A, comp, plate, "ADBE Gaussian Blur 2");
    add(A, comp, plate, "ADBE Glo2");
    const opacity = plate.transform("Opacity");
    opacity.expression = 'effect(2)("Glow Radius")';
    opacity.expressionEnabled = true;
    const other = matte.transform("Opacity");
    other.expression = 'thisComp.layer("Plate").effect(1)("Blurriness")';
    other.expressionEnabled = true;
    const rot = matte.transform("Rotation");
    rot.expression = 'effect(1)("x")'; // on Matte itself: not this layer's effects
    rot.expressionEnabled = true;
    const byName = plate.transform("Rotation");
    byName.expression = 'effect("Glow")("Glow Radius")';
    byName.expressionEnabled = true;
    const out = set(A, comp, plate, { effect: { index: 1 }, move_to: 2 });
    expect(out.expression_warnings.map((w: any) => [w.layer, w.property])).toEqual([
      ["Plate", "Transform > Opacity"],
      ["Matte", "Transform > Opacity"],
    ]);
    // a call that does not reorder does not scan
    expect(set(A, comp, plate, { effect: { index: 1 }, enabled: false }).expression_warnings).toBeUndefined();
  });

  it("takes a half-made effect back out when a value is refused, inside the same undo group", () => {
    const { project, comp, plate, parade } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    expect(() => add(A, comp, plate, "ADBE Gaussian Blur 2", { params: [{ param: "Blurriness", value: 5 }, { param: "Blur Dimensions", value: "Diagonal" }] })).toThrow(/No menu item/);
    expect(parade.numProperties).toBe(0);
    expect(undo.begun).toBe(1);
    expect(undo.ended).toBe(1);
    const ok = add(A, comp, plate, "ADBE Gaussian Blur 2", { params: [{ param: "Blur Dimensions", value: "Horizontal" }] });
    expect(ok.params_set[0]).toMatchObject({ resolved_value: 2, label: "Horizontal" });
  });

  it("layer styles: adds one when AE allows it, otherwise says to use a preset", () => {
    const { project, comp, plate } = effectScene();
    const { A, undo } = loadHost(project, ["effects.jsx"]);
    const styles: any = new FakeGroup("Layer Styles", "ADBE Layer Styles", []);
    styles.parentProperty = plate.group;
    plate.group.props.push(styles);
    styles.canAddProperty = () => false;
    expect(() => add(A, comp, plate, "dropShadow")).toThrow(/not addable by script, use a preset/);
    expect(undo.begun).toBe(0);
    styles.canAddProperty = () => true;
    styles.addProperty = () => {
      throw new Error("Unable to add");
    };
    expect(() => add(A, comp, plate, "dropShadow")).toThrow(/use a preset.*Unable to add/);
    let added = "";
    styles.addProperty = (m: string) => {
      added = m;
    };
    const out = add(A, comp, plate, "dropShadow");
    expect(added).toBe("dropShadow/enabled");
    expect(out).toMatchObject({ layer_style: true, style: "dropShadow" });
    expect(() => add(A, comp, plate, "dropShadow", { params: [{ param: 1, value: 1 }] })).toThrow(/params do not apply/);
    plate.locked = true;
    expect(() => add(A, comp, plate, "dropShadow")).toThrow(/locked/);
  });

  it("ae_add_effect and ae_set_effect keep working as before for plain values", () => {
    const { project, comp, plate } = effectScene();
    const { A } = loadHost(project, ["effects.jsx"]);
    const out = add(A, comp, plate, "ADBE Gaussian Blur 2", { name: "Soft", params: [{ param: "Blurriness", value: 25 }, { param: "Repeat Edge Pixels", value: true }] });
    expect(out).toMatchObject({ index: 1, name: "Soft", matchName: "ADBE Gaussian Blur 2" });
    expect(out.params_set).toEqual([{ param: "Blurriness", how: "value" }, { param: "Repeat Edge Pixels", how: "value" }]);
    const set2 = set(A, comp, plate, { enabled: false, name: "Softer" });
    expect(set2).toMatchObject({ index: 1, name: "Softer", enabled: false, params_set: [] });
  });
});

// ---------- shapes.jsx under node:vm ----------

function shapeScene(extra: Record<string, unknown> = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const layer = comp.layers.addShape();
  const host = loadHost(project, ["shapes.jsx"], extra);
  const edit = (o: object) => host.A.shapeEdit({ comp_id: comp.id, layer: { id: layer.id }, expect: GUARD, ...o });
  const read = () => host.A.shapeContents({ comp_id: comp.id, layer: { id: layer.id } });
  const root = layer.property("ADBE Root Vectors Group") as any;
  return { project, comp, layer, host, edit, read, root, undo: host.undo };
}

const rect = (name: string, extra: object = {}) => ({ type: "rect", name, size: [100, 50], ...extra });

describe("shapes.jsx", () => {
  it("adds a stroke with caps, joins, dashes, taper and wave and reads them back", () => {
    const { edit, read } = shapeScene();
    const spec = rect("Card", {
      stroke: { color: [1, 1, 1], width: 4, line_cap: "round", line_join: "bevel", miter_limit: 6, dashes: [{ dash: 10, gap: 5 }, { dash: 20, gap: 8 }], dash_offset: 2, taper: { start_length: 20, end_width: 50 }, wave: { amount: 3, phase: 45 } },
      fill: { color: [1, 0, 0], rule: "even_odd" },
    });
    const out = edit({ add: [spec] });
    expect(out.added).toEqual([{ index: 1, name: "Card" }]);
    const back = read();
    const items = back.contents[0].items;
    const stroke = items.find((i: any) => i.kind === "stroke");
    expect(stroke).toMatchObject({ width: 4, line_cap: 2, line_join: 3, miter_limit: 6 });
    expect(stroke.dashes.map((d: any) => [d.matchName, d.value])).toEqual([
      ["ADBE Vector Stroke Dash 1", 10], ["ADBE Vector Stroke Gap 1", 5], ["ADBE Vector Stroke Dash 2", 20], ["ADBE Vector Stroke Gap 2", 8], ["ADBE Vector Stroke Offset", 2],
    ]);
    expect(stroke.taper).toMatchObject({ start_length: 20, end_width: 50, end_length: 0 });
    expect(stroke.wave).toMatchObject({ amount: 3, phase: 45 });
    expect(items.find((i: any) => i.kind === "fill")).toMatchObject({ rule: 2 });
    const parsed: any = AeShapeSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [spec], expect: expectArg });
    expect(shapeMismatches(parsed.add, { count: 0, contents: [], truncated: false }, back, out)).toEqual([]);
  });

  it("adds gradient fills and strokes with type, points and highlight", () => {
    const { edit, read } = shapeScene();
    const spec = {
      type: "ellipse", name: "Orb", size: [80, 80],
      gradient_fill: { type: "radial", start_point: [0, 0], end_point: [40, 0], highlight_length: 25, highlight_angle: 30, opacity: 80, rule: "non_zero" },
      gradient_stroke: { type: "linear", width: 6, start_point: [-40, 0], end_point: [40, 0], line_cap: "projecting", dashes: [{ dash: 4, gap: 4 }] },
    };
    const out = edit({ add: [spec] });
    expect(out.added[0].gradient_colors).toMatch(/default ramp/);
    const back = read();
    const gf = back.contents[0].items.find((i: any) => i.kind === "gradient_fill");
    const gs = back.contents[0].items.find((i: any) => i.kind === "gradient_stroke");
    expect(gf).toMatchObject({ gradient_type: 2, start_point: [0, 0], end_point: [40, 0], highlight_length: 25, highlight_angle: 30, opacity: 80, rule: 1 });
    expect(gs).toMatchObject({ gradient_type: 1, width: 6, line_cap: 3 });
    expect(gs.dashes[0].value).toBe(4);
    const parsed: any = AeShapeSchema.parse({ comp_id: 1, layer: { index: 1 }, add: [spec], expect: expectArg });
    expect(shapeMismatches(parsed.add, { count: 0, contents: [], truncated: false }, back, out)).toEqual([]);
  });

  it("keeps the old add and remove behaviour", () => {
    const { edit, read } = shapeScene();
    edit({ add: [rect("A", { fill: { color: [1, 0, 0] } }), rect("B", { stroke: { color: [0, 0, 0], width: 2 } })] });
    const out = edit({ remove: [{ name: "A" }] });
    expect(out.removed).toEqual([{ index: 1, name: "A" }]);
    expect(read().contents.map((c: any) => c.name)).toEqual(["B"]);
  });

  it("refuses bad stroke and gradient settings, and taper or wave on an old AE, before the undo group", () => {
    const { edit, undo, root } = shapeScene();
    const stroke = (o: object) => ({ add: [rect("X", { stroke: { color: [1, 1, 1], width: 1, ...o } })] });
    expect(() => edit(stroke({ line_cap: "square" }))).toThrow(/line_cap/);
    expect(() => edit(stroke({ dashes: [{ dash: 1, gap: 1 }, { dash: 1, gap: 1 }, { dash: 1, gap: 1 }, { dash: 1, gap: 1 }] }))).toThrow(/1 to 3/);
    expect(() => edit(stroke({ dashes: [{ dash: -1, gap: 1 }] }))).toThrow(/dash and gap/);
    expect(() => edit(stroke({ dash_offset: 2 }))).toThrow(/goes with dashes/);
    expect(() => edit({ add: [rect("X", { gradient_fill: { type: "conic" } })] })).toThrow(/linear or radial/);
    expect(() => edit({ add: [rect("X", { fill: { color: [1, 0, 0], rule: "odd" } })] })).toThrow(/rule/);
    expect(() => edit({ add: [rect("X", { fill: { color: [1, 0, 0] }, gradient_fill: { type: "linear" } })] })).toThrow(/not both/);
    expect(undo.begun).toBe(0);
    expect(root.numProperties).toBe(0);
    const old = shapeScene({ version: "16.1.0" });
    expect(() => old.edit(stroke({ taper: { start_length: 10 } }))).toThrow(/17\.1\.1/);
    expect(() => old.edit(stroke({ wave: { amount: 1 } }))).toThrow(/17\.1\.1/);
    expect(old.undo.begun).toBe(0);
    // a plain stroke is fine on the old version
    old.edit(stroke({ line_cap: "round" }));
    expect(old.undo.begun).toBe(1);
  });

  it("takes this call's groups back out when a step fails (a missing taper group), in the same undo group", () => {
    const { edit, undo, root } = shapeScene();
    edit({ add: [rect("Keep")] });
    opts.dropTaper = true;
    expect(() => edit({ add: [rect("Plain"), rect("Bad", { stroke: { color: [1, 1, 1], width: 1, taper: { start_length: 10 } } })] })).toThrow(/Stroke taper group .* is missing/);
    expect(root.numProperties).toBe(1);
    expect(root.property(1).name).toBe("Keep");
    expect(undo.begun).toBe(2);
    expect(undo.ended).toBe(2);
    opts.dropTaper = false;
    opts.dropMiterLimit = true;
    expect(() => edit({ add: [rect("Bad", { stroke: { color: [1, 1, 1], width: 1, miter_limit: 5 } })] })).toThrow(/No ADBE Vector Stroke Miter Limit/);
    expect(root.numProperties).toBe(1);
  });

  const abc = () => {
    const s = shapeScene();
    s.edit({ add: [rect("A"), rect("B"), rect("C")] });
    return s;
  };
  const order = (s: { root: any }) => s.root.props.map((p: any) => p.name);

  it("duplicates groups with a count, high index first, and reports where each landed", () => {
    for (const before of [false, true]) {
      opts.dupBefore = before;
      const s = abc();
      const begun = s.undo.begun;
      const out = s.edit({ duplicate: [{ name: "A", count: 2 }, { index: 3 }] });
      expect(s.root.numProperties).toBe(6);
      expect(out.duplicate_located).toBe(true);
      const recs = out.duplicated;
      const byName: Record<string, any> = {};
      for (const r of recs) byName[r.source_name] = r;
      expect(byName.A.copies).toHaveLength(2);
      expect(byName.C.copies).toHaveLength(1);
      // every reported position holds a rectangle group, the sources keep their names
      for (const r of recs) {
        for (const c of r.copies) expect(s.root.property(c.index).matchName).toBe("ADBE Vector Group");
        expect(s.root.property(r.source_index_after).name).toBe(r.source_name);
      }
      const all = [...recs.flatMap((r: any) => r.copies.map((c: any) => c.index)), ...recs.map((r: any) => r.source_index_after), s.root.props.findIndex((p: any) => p.name === "B") + 1];
      expect(new Set(all).size).toBe(6);
      expect(s.undo.begun).toBe(begun + 1);
      expect(s.undo.ended).toBe(begun + 1);
      const parsed = { count: 3, contents: ["A", "B", "C"].map((n, i) => ({ index: i + 1, name: n, matchName: "ADBE Vector Group", kind: "group" })), truncated: false };
      expect(shapeMismatches([], parsed, s.read(), out)).toEqual([]);
    }
  });

  it("says so when AE does not report where a copy went", () => {
    opts.dupUnlocatable = true;
    const s = abc();
    const out = s.edit({ duplicate: [{ name: "A", count: 3 }] });
    expect(out.duplicate_located).toBe(false);
    expect(out.duplicated[0].copies).toEqual([]);
  });

  it("moves groups one after another and reports each move", () => {
    const s = abc();
    const out = s.edit({ move: [{ name: "C", to: 1 }, { name: "B", to: 3 }] });
    expect(order(s)).toEqual(["C", "A", "B"]);
    expect(out.moved).toEqual([{ name: "C", from: 3, to: 1 }, { name: "B", from: 3, to: 3 }]);
    expect(applyMoves(["A", "B", "C"], out.moved)).toEqual(["C", "A", "B"]);
    s.edit({ move: [{ index: 1, to: 3 }] });
    expect(order(s)).toEqual(["A", "B", "C"]);
  });

  it("a move to where the content already is changes nothing: no_op, no undo group", () => {
    const s = abc();
    const begun = s.undo.begun;
    const out = s.edit({ move: [{ name: "B", to: 2 }] });
    expect(out.no_op).toBe(true);
    expect(s.undo.begun).toBe(begun);
  });

  it("refuses combinations, bad positions, duplicates by an ambiguous name and a locked layer before writing", () => {
    const s = abc();
    s.edit({ add: [rect("A")] });
    const begun = s.undo.begun;
    expect(() => s.edit({ duplicate: [{ index: 1 }], remove: [{ index: 2 }] })).toThrow(/can't be combined/);
    expect(() => s.edit({ move: [{ index: 1, to: 2 }], remove: [{ index: 2 }] })).toThrow(/can't be combined/);
    expect(() => s.edit({ duplicate: [{ index: 1 }], move: [{ index: 2, to: 1 }] })).toThrow(/can't be combined/);
    expect(() => s.edit({ move: [{ name: "B", to: 9 }] })).toThrow(/move\.to must be/);
    expect(() => s.edit({ move: [{ name: "Nope", to: 1 }] })).toThrow(/No content named/);
    expect(() => s.edit({ move: [{ name: "A", to: 1 }] })).toThrow(/2 contents are named "A"; move by index/);
    expect(() => s.edit({ duplicate: [{ name: "A" }] })).toThrow(/duplicate by index/);
    expect(() => s.edit({ duplicate: [{ index: 2 }, { index: 2 }] })).toThrow(/listed twice/);
    expect(() => s.edit({ duplicate: [{ index: 2, count: 51 }] })).toThrow(/1\.\.50/);
    expect(() => s.edit({ duplicate: [{ index: 9 }] })).toThrow(/out of range/);
    s.layer.locked = true;
    expect(() => s.edit({ move: [{ index: 1, to: 2 }] })).toThrow(/locked/);
    expect(() => s.edit({ duplicate: [{ index: 1 }] })).toThrow(/locked/);
    s.layer.locked = false;
    expect(s.undo.begun).toBe(begun);
    expect(s.root.numProperties).toBe(4);
  });

  it("warns about content(n) expressions after a reorder, and not otherwise", () => {
    const s = abc();
    const second = s.comp.layers.addNull();
    const rot = second.transform("Rotation");
    rot.expression = 'thisComp.layer("Shape Layer 1").content(2).transform.rotation';
    rot.expressionEnabled = true;
    const unrelated = second.transform("Opacity");
    unrelated.expression = "content(1)";
    unrelated.expressionEnabled = true;
    const out = s.edit({ move: [{ name: "C", to: 1 }] });
    expect(out.expression_warnings.map((w: any) => [w.layer, w.property])).toEqual([["Null 1", "Transform > Rotation"]]);
    expect(s.edit({ add: [rect("D")] }).expression_warnings).toBeUndefined();
  });

  it("says the scan covered this comp only", () => {
    const s = abc();
    const out = s.edit({ move: [{ name: "C", to: 1 }] });
    expect(out.expression_scan_scope).toMatch(/this comp's layers only/);
  });

  it("refuses add with duplicate or move, and values past AE's limits, before any undo group", () => {
    const s = abc();
    const begun = s.undo.begun;
    expect(() => s.edit({ add: [rect("D")], duplicate: [{ index: 1 }] })).toThrow(/add can't be combined/);
    expect(() => s.edit({ add: [rect("D")], move: [{ index: 1, to: 2 }] })).toThrow(/add can't be combined/);
    expect(() => s.edit({ add: [rect("D", { stroke: { color: [1, 1, 1], width: 1, taper: { start_length: 150 } } })] })).toThrow(/taper.start_length/);
    expect(() => s.edit({ add: [rect("D", { gradient_fill: { type: "linear", highlight_length: 300 } })] })).toThrow(/highlight_length/);
    expect(() => s.edit({ add: [rect("D", { stroke: { color: [1, 1, 1], width: 1, miter_limit: 0 } })] })).toThrow(/miter_limit/);
    expect(s.undo.begun).toBe(begun);
    expect(AeShapeSchema.safeParse({ comp_id: 1, layer: { index: 1 }, add: [rect("D")], duplicate: [{ index: 1 }], expect: expectArg }).success).toBe(false);
  });
});

// ---------- paths.jsx under node:vm ----------

function operatorScene(extra: Record<string, unknown> = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 640, 360, 4);
  const layer = comp.layers.addShape();
  const root = layer.property("ADBE Root Vectors Group") as any;
  const group = root.addProperty("ADBE Vector Group") as any;
  const vectors = group.property("ADBE Vectors Group") as any;
  vectors.addProperty("ADBE Vector Shape - Rect");
  vectors.addProperty("ADBE Vector Shape - Ellipse");
  const host = loadHost(project, ["paths.jsx"], extra);
  const base = { comp_id: comp.id, layer: { id: layer.id }, group: { index: 1 } };
  const go = (o: object) => host.A.pathsOperator({ ...base, expect: GUARD, ...o });
  const read = () => host.A.pathsOperators(base);
  const check = (args: object, before: object, out: object) => operatorMismatches(AePathOperatorSchema.parse({ ...base, expect: GUARD, ...args }), before, read(), out);
  return { project, comp, layer, vectors, host, go, read, check, undo: host.undo, base };
}

describe("paths.jsx: the newer operators", () => {
  const empty = (n: number) => ({ group: { index: 1, name: "Group 1" }, count: n, items: [], truncated: false });

  it("adds Merge Paths last in the group with its mode", () => {
    const s = operatorScene();
    const out = s.go({ operator: "merge", merge: { mode: "subtract" }, name: "Cut" });
    expect(out.added).toEqual([{ index: 3, name: "Cut", matchName: "ADBE Vector Filter - Merge" }]);
    expect((s.vectors.property(3) as any).property("ADBE Vector Merge Type").value).toBe(3);
    const read = s.read();
    expect(read.items[2]).toMatchObject({ kind: "merge", mode: 3 });
    expect(s.check({ operator: "merge", merge: { mode: "subtract" }, name: "Cut" }, empty(2), out)).toEqual([]);
    expect(s.undo.begun).toBe(1);
    expect(s.undo.ended).toBe(1);
  });

  it("adds Round Corners, Zig Zag, Pucker & Bloat and Twist with their settings", () => {
    const s = operatorScene();
    const cases: Array<[object, string, Record<string, unknown>]> = [
      [{ operator: "round_corners", round_corners: { radius: 24 } }, "ADBE Vector Filter - RC", { radius: 24 }],
      [{ operator: "zig_zag", zig_zag: { size: 12, ridges_per_segment: 7, points: "smooth" } }, "ADBE Vector Filter - Zigzag", { size: 12, ridges_per_segment: 7, points: 2 }],
      [{ operator: "pucker_bloat", pucker_bloat: { amount: -35 } }, "ADBE Vector Filter - PB", { amount: -35 }],
      [{ operator: "twist", twist: { angle: 120, center: [5, -5] } }, "ADBE Vector Filter - Twist", { angle: 120, center: [5, -5] }],
    ];
    let n = 2;
    for (const [args, match, expected] of cases) {
      const out = s.go(args);
      n++;
      expect(out.added[0]).toMatchObject({ index: n, matchName: match });
      expect(s.read().items[n - 1]).toMatchObject(expected);
      expect(s.check(args, empty(n - 1), out)).toEqual([]);
      if ((args as any).operator === "zig_zag") expect(out.points_mapping).toMatch(/unverified/);
    }
  });

  it("adds Wiggle Paths and Wiggle Transform, with the Transform group's children listed", () => {
    const s = operatorScene();
    const wp = { operator: "wiggle_paths", wiggle_paths: { size: 8, detail: 3, points: "corner", wiggles_per_second: 4, correlation: 20, temporal_phase: 15, spatial_phase: 30, random_seed: 42 } };
    const out1 = s.go(wp);
    expect(s.read().items[2]).toMatchObject({ kind: "wiggle_paths", size: 8, detail: 3, points: 1, wiggles_per_second: 4, correlation: 20, temporal_phase: 15, spatial_phase: 30, random_seed: 42 });
    expect(s.check(wp, empty(2), out1)).toEqual([]);
    const wt = { operator: "wiggle_transform", wiggle_transform: { wiggles_per_second: 5, random_seed: 9, transform: { position: [30, 40], rotation: 12 } } };
    const out2 = s.go(wt);
    expect(out2.transform_children.map((c: any) => c.name)).toEqual(["Position", "Scale", "Rotation"]);
    const item = s.read().items[3];
    expect(item).toMatchObject({ kind: "wiggle_transform", wiggles_per_second: 5, random_seed: 9 });
    expect(item.transform.find((c: any) => c.name === "Position").value).toEqual([30, 40]);
    expect(s.check(wt, empty(3), out2)).toEqual([]);
    const wrong = { ...wt, wiggle_transform: { transform: { position: [1, 1] } } };
    expect(s.check(wrong, empty(3), out2).some((m) => m.path.startsWith("items[4].transform.position"))).toBe(true);
  });

  it("refuses bad settings before the undo group opens and takes a half-added operator back out", () => {
    const s = operatorScene();
    expect(() => s.go({ operator: "merge", merge: { mode: "xor" } })).toThrow(/merge\.mode must be one of/);
    expect(() => s.go({ operator: "round_corners", round_corners: { radius: -4 } })).toThrow(/radius/);
    expect(() => s.go({ operator: "zig_zag", zig_zag: { ridges_per_segment: 2.5 } })).toThrow(/whole number/);
    expect(() => s.go({ operator: "zig_zag", zig_zag: { points: "round" } })).toThrow(/corner, smooth/);
    expect(() => s.go({ operator: "pucker_bloat", pucker_bloat: { amount: 400 } })).toThrow(/-100\.\.100/);
    expect(() => s.go({ operator: "twist", twist: { center: [1] } })).toThrow(/\[x, y\]/);
    expect(() => s.go({ operator: "wiggle_paths", wiggle_paths: { correlation: 120 } })).toThrow(/0\.\.100/);
    expect(() => s.go({ operator: "wiggle_paths", wiggle_paths: { bogus: 1 } })).toThrow(/not a setting/);
    expect(() => s.go({ operator: "wiggle_transform", wiggle_transform: { transform: { scale: [1] } } })).toThrow(/scale/);
    expect(() => s.go({ operator: "blur" })).toThrow(/operator must be .*wiggle_transform/);
    expect(s.undo.begun).toBe(0);
    expect(s.vectors.numProperties).toBe(2);
    // AE has no such child: the operator is rolled back inside the group
    delete (FACTORY as any)["ADBE Vector Filter - Wiggler"];
    FACTORY["ADBE Vector Filter - Wiggler"] = (n: number) =>
      new FakeGroup(`Wiggle Transform ${n}`, "ADBE Vector Filter - Wiggler", [P("Wiggles/Second", "ADBE Vector Xform Temporal Freq", PropertyValueType.OneD, 2)]);
    expect(() => s.go({ operator: "wiggle_transform", wiggle_transform: { transform: { position: [1, 1] } } })).toThrow(/Transform group/);
    expect(s.vectors.numProperties).toBe(2);
    expect(s.undo.begun).toBe(1);
    expect(s.undo.ended).toBe(1);
  });

  it("keeps Trim, Offset and Repeater as they were", () => {
    const s = operatorScene();
    expect(() => s.go({ operator: "trim", trim: { end: 120 } })).toThrow(/0\.\.100/);
  });
});
