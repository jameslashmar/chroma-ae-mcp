import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import {
  AeExprRecipeSchema,
  AeRigAddControlsSchema,
  AeRigLinkSchema,
  AeRigListSchema,
  AeRigRenameSchema,
  AeRigUnlinkSchema,
  ControlSpecSchema,
  RECIPES,
  controlMismatches,
  controlSpecProblem,
  expectedControlValue,
  expressionMismatches,
  planRecipeControls,
  recipeByName,
  recipeControlName,
  renameMismatches,
  resolveRecipeParams,
  rigTools,
  unlinkMismatches,
  valuesMatch,
  type ControlSpec,
} from "../src/tools/ext/rig.js";
import {
  FakeGroup,
  FakeProject,
  FakeProperty,
  GUARD,
  PropertyType,
  PropertyValueType,
  loadHost,
  type FakeComp,
  type FakeLayer,
} from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => rigTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

// ---------- the AE fake, extended for this group ----------

/** What the armed properties and the effect parade do on this scene. */
const sim = {
  /** Make setting an expression throw, as AE does for a syntax error. */
  rejectExpr: null as null | ((v: string) => boolean),
  /** Make Dropdown Control's setPropertyParameters throw. */
  dropdownFails: false,
  project: null as null | FakeProject,
};

const DEFAULTS: Record<string, [string, number, unknown]> = {
  "ADBE Slider Control": ["Slider Control", PropertyValueType.OneD, 0],
  "ADBE Angle Control": ["Angle Control", PropertyValueType.OneD, 0],
  "ADBE Checkbox Control": ["Checkbox Control", PropertyValueType.OneD, 0],
  "ADBE Color Control": ["Color Control", PropertyValueType.COLOR, [1, 0, 0, 1]],
  "ADBE Point Control": ["Point Control", PropertyValueType.TwoD, [320, 180]],
  "ADBE Point3D Control": ["3D Point Control", PropertyValueType.ThreeD, [0, 0, 0]],
  "ADBE Layer Control": ["Layer Control", PropertyValueType.LAYER_INDEX, 0],
  "ADBE Dropdown Control": ["Dropdown Menu Control", PropertyValueType.OneD, 1],
};

/** Gives a property an expression that can fail: a syntax hook, and an error for a control that is gone. */
function arm(p: FakeProperty, owner?: FakeLayer) {
  let expr = "";
  Object.defineProperty(p, "expression", {
    configurable: true,
    get: () => expr,
    set: (v: string) => {
      if (sim.rejectExpr?.(v)) throw new Error("Expression syntax error");
      expr = v;
      p.expressionEnabled = v !== "";
    },
  });
  Object.defineProperty(p, "expressionError", {
    configurable: true,
    get: () => {
      if (!expr || !owner) return "";
      for (const m of expr.matchAll(/(?:thisComp\.layer\("([^"]*)"\)\.)?effect\("([^"]*)"\)/g)) {
        const holder = m[1] ? owner.comp.stack.find((l) => l.name === m[1]) : owner;
        const par = holder?.group.property("ADBE Effect Parade") as FakeGroup | null | undefined;
        if (!par || !par.props.some((fx) => fx.name === m[2])) return `Effect named "${m[2]}" is missing or does not exist`;
      }
      return "";
    },
  });
}

function armGroup(g: FakeGroup | FakeLayer["group"], owner: FakeLayer) {
  for (const p of g.props) {
    if (p instanceof FakeProperty) arm(p, owner);
    else armGroup(p, owner);
  }
}
const armLayer = (l: FakeLayer) => armGroup(l.group, l);

const origAdd = FakeGroup.prototype.addProperty;
beforeAll(() => {
  FakeGroup.prototype.addProperty = function (this: FakeGroup, matchName: string) {
    if (this.matchName !== "ADBE Effect Parade") return origAdd.call(this, matchName);
    const d = DEFAULTS[matchName];
    if (!d) throw new Error(`Can't add ${matchName}`);
    const leaf = new FakeProperty("Slider", `${matchName}-0001`, d[1], d[2]);
    const items: string[] = [];
    Object.assign(leaf, {
      setPropertyParameters: (list: string[]) => {
        if (sim.dropdownFails) throw new Error("setPropertyParameters failed");
        items.splice(0, items.length, ...list);
        return leaf;
      },
      propertyParameters: items,
    });
    const g = new FakeGroup(d[0], matchName, [leaf]);
    Object.defineProperty(g, "propertyIndex", { get: () => this.props.indexOf(g) + 1 });
    g.parentProperty = this;
    this.props.push(g);
    arm(leaf);
    return g;
  } as typeof origAdd;
});
afterAll(() => {
  FakeGroup.prototype.addProperty = origAdd;
});

interface Scene {
  project: FakeProject;
  comp: FakeComp;
  A: Record<string, (a: unknown) => unknown>;
  undo: { begun: number; ended: number };
  ctl: FakeLayer;
  box: FakeLayer;
  text: FakeLayer;
  fixes: Array<[string, string]>;
}

function scene(opts: { autoFix?: boolean } = {}): Scene {
  sim.rejectExpr = null;
  sim.dropdownFails = false;
  const project = new FakeProject();
  sim.project = project;
  const comp = project.addComp("Main", 640, 360, 4);
  (project as unknown as Record<string, unknown>).expressionEngine = "javascript-1.0";
  const fixes: Array<[string, string]> = [];
  if (opts.autoFix !== false) {
    // Like AE's: it repairs only expressions that error now.
    (project as unknown as Record<string, unknown>).autoFixExpressions = (oldText: string, newText: string) => {
      fixes.push([oldText, newText]);
      const fix = (g: FakeGroup | FakeLayer["group"]) => {
        for (const p of g.props) {
          if (p instanceof FakeProperty) {
            if (p.expression && p.expressionError && p.expression.includes(oldText)) p.expression = p.expression.split(oldText).join(newText);
          } else fix(p);
        }
      };
      for (const it of project.all) for (const l of (it as FakeComp).stack ?? []) fix(l.group);
    };
  }
  const { A, undo } = loadHost(project, ["rig.jsx"]);
  const ctl = comp.layers.addNull(4) as FakeLayer;
  ctl.name = "Controls";
  const box = comp.layers.addSolid([1, 1, 1], "Box", 100, 100, 1, 4) as FakeLayer;
  const text = comp.layers.addText("Hello") as FakeLayer;
  for (const l of [ctl, box, text]) armLayer(l);
  return { project, comp, A, undo, ctl, box, text, fixes };
}

/** Runs a host function and returns what it gave, through JSON as the bridge does. */
function run(s: Scene, fn: string, args: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(s.A[fn]({ comp_id: s.comp.id, expect: GUARD, ...args })));
}

/** The error a host function throws. */
function fails(s: Scene, fn: string, args: Record<string, unknown>) {
  try {
    s.A[fn]({ comp_id: s.comp.id, expect: GUARD, ...args });
  } catch (e) {
    const err = e as Error & { __kind?: string };
    return { kind: err.__kind, message: err.message };
  }
  throw new Error(`${fn} did not throw`);
}

const effectsOf = (l: FakeLayer) => (l.group.property("ADBE Effect Parade") as FakeGroup).props;
const propOf = (l: FakeLayer, ...path: string[]) => {
  let p: FakeGroup | FakeProperty | FakeLayer = l;
  for (const k of path) p = (p as FakeLayer).property(k) as FakeGroup;
  return p as unknown as FakeProperty;
};
const POS = ["ADBE Transform Group", "ADBE Position"];
const OPACITY = ["ADBE Transform Group", "ADBE Opacity"];
const SCALE = ["ADBE Transform Group", "ADBE Scale"];
const ROT = ["ADBE Transform Group", "ADBE Rotate Z"];

/** A 2D property on a layer: a rectangle path's Size, as a shape layer has. */
function addSize(layer: FakeLayer) {
  const p = new FakeProperty("Size", "ADBE Vector Rect Size", PropertyValueType.TwoD, [100, 100]);
  p.parentProperty = layer.group;
  layer.group.props.push(p);
  arm(p, layer);
  return ["ADBE Vector Rect Size"];
}

/** A colour property on a layer. */
function addColor(layer: FakeLayer) {
  const p = new FakeProperty("Fill Color", "ADBE Fill Color", PropertyValueType.COLOR, [1, 0, 0, 1]);
  p.parentProperty = layer.group;
  layer.group.props.push(p);
  arm(p, layer);
  return ["ADBE Fill Color"];
}

// ---------- a bridge with scripted answers, for the guarded flow ----------

function fakeAe(results: Record<string, unknown[]>, opts: { failOn?: string } = {}) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-rig-q-"));
  tmpDirs.push(dir);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const seen: Record<string, number> = {};
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, script });
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      seen[fn] = (seen[fn] ?? 0) + 1;
      if (opts.failOn === `${fn}#${seen[fn]}`) throw new Error("the panel stopped answering");
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

// ---------- schemas ----------

describe("rig schemas", () => {
  it("exports six write/read tools plus the catalogue, and every writer takes expect and the safety text", () => {
    expect(rigTools.map((t) => t.name)).toEqual([
      "ae_rig_add_controls",
      "ae_rig_link",
      "ae_rig_unlink",
      "ae_rig_rename",
      "ae_rig_list",
      "ae_expr_recipes",
      "ae_expr_recipe",
    ]);
    for (const name of ["ae_rig_add_controls", "ae_rig_link", "ae_rig_unlink", "ae_rig_rename", "ae_expr_recipe"]) {
      expect(tool(name).description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
      expect(tool(name).schema.safeParse({}).success).toBe(false);
    }
    expect(tool("ae_rig_list").description).not.toContain(AGENT_SAFETY_GUIDANCE);
  });

  it("control specs accept each kind and refuse the unsafe ones", () => {
    const ok = (v: unknown) => ControlSpecSchema.safeParse(v).success;
    expect(ok({ name: "Speed", kind: "slider", value: 50 })).toBe(true);
    expect(ok({ name: "On", kind: "checkbox", value: true })).toBe(true);
    expect(ok({ name: "Tint", kind: "color", value: [1, 0.5, 0] })).toBe(true);
    expect(ok({ name: "P", kind: "point", value: [1, 2] })).toBe(true);
    expect(ok({ name: "P3", kind: "point3d", value: [1, 2, 3] })).toBe(true);
    expect(ok({ name: "Pick", kind: "layer", layer: { name: "Box" } })).toBe(true);
    expect(ok({ name: "Mode", kind: "dropdown", items: ["A", "(-", "B"], value: 3 })).toBe(true);
    // A quote or backslash can't be named safely inside an expression.
    expect(ok({ name: 'Say "hi"', kind: "slider" })).toBe(false);
    expect(ok({ name: "a\\b", kind: "slider" })).toBe(false);
    expect(ok({ name: "Mode", kind: "dropdown" })).toBe(false);
    expect(ok({ name: "Mode", kind: "dropdown", items: ["A", "A"] })).toBe(false);
    expect(ok({ name: "Mode", kind: "dropdown", items: ["A", "B\\C"] })).toBe(false);
    expect(ok({ name: "Mode", kind: "dropdown", items: ["A", "(-"], value: 2 })).toBe(false);
    expect(ok({ name: "Mode", kind: "dropdown", items: ["A", "B"], value: 3 })).toBe(false);
    expect(ok({ name: "S", kind: "slider", items: ["A"] })).toBe(false);
    expect(ok({ name: "S", kind: "slider", value: 1e12 })).toBe(false);
    expect(ok({ name: "L", kind: "layer", value: 3 })).toBe(false);
    expect(ok({ name: "C", kind: "color", value: [2, 0, 0] })).toBe(false);
    expect(ok({ name: "P", kind: "point", value: [1, 2, 3] })).toBe(false);
    expect(controlSpecProblem({ name: "x", kind: "checkbox", value: 5 })).toMatch(/true or false/);
  });

  it("add_controls needs unique names, and a name to create a missing layer by", () => {
    const base = { comp_id: 1, layer: { name: "Controls" }, expect: expectArg };
    const a = { name: "A", kind: "slider" };
    expect(AeRigAddControlsSchema.safeParse({ ...base, controls: [a, { ...a, kind: "angle" }] }).success).toBe(false);
    expect(AeRigAddControlsSchema.safeParse({ ...base, controls: [a], create_if_missing: true }).success).toBe(true);
    expect(AeRigAddControlsSchema.safeParse({ ...base, layer: { index: 3 }, controls: [a], create_if_missing: true }).success).toBe(false);
    expect(AeRigAddControlsSchema.safeParse({ ...base, controls: [] }).success).toBe(false);
  });

  it("link specs check the remap and the axis", () => {
    const link = { layer: { name: "Box" }, path: ["Transform", "Opacity"], control: { name: "Speed" } };
    const wrap = (l: object) => ({ comp_id: 1, links: [l], expect: expectArg });
    expect(AeRigLinkSchema.safeParse(wrap(link)).success).toBe(true);
    expect(AeRigLinkSchema.safeParse(wrap({ ...link, remap: { in_min: 0, in_max: 0, out_min: 0, out_max: 1 } })).success).toBe(false);
    expect(AeRigLinkSchema.safeParse(wrap({ ...link, remap: { in_min: 0, in_max: 100, out_min: 0, out_max: 1 }, multiplier: 2, axis: 1 })).success).toBe(true);
    expect(AeRigLinkSchema.safeParse(wrap({ ...link, axis: 3 })).success).toBe(false);
    expect(AeRigLinkSchema.safeParse(wrap({ ...link, path: [] })).success).toBe(false);
    expect(AeRigLinkSchema.safeParse(wrap({ ...link, control: { name: 'a"b' } })).success).toBe(false);
    expect(AeRigUnlinkSchema.safeParse({ comp_id: 1, targets: [{ layer: { name: "Box" }, path: ["Opacity"] }], expect: expectArg }).success).toBe(true);
    expect(AeRigRenameSchema.safeParse({ comp_id: 1, layer: { name: "Controls" }, control: "A", new_name: "B", expect: expectArg }).success).toBe(true);
    expect(AeRigListSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(AeExprRecipeSchema.safeParse({ comp_id: 1, layer: { name: "Box" }, path: ["Opacity"], recipe: "nope", expect: expectArg }).success).toBe(false);
  });
});

// ---------- pure logic ----------

describe("recipe catalogue", () => {
  it("has unique recipes, each with usable control names", () => {
    expect(new Set(RECIPES.map((r) => r.name)).size).toBe(RECIPES.length);
    for (const r of RECIPES) {
      const plan = planRecipeControls(r, undefined, undefined);
      expect(plan.ok, r.name).toBe(true);
      if (plan.ok) expect(new Set(plan.controls.map((c) => c.name)).size).toBe(plan.controls.length);
    }
  });

  it("names controls from the prefix and label", () => {
    expect(recipeControlName("Wiggle", "Frequency")).toBe("Wiggle Frequency");
    expect(recipeControlName("Logo Scale", "")).toBe("Logo Scale");
    const plan = planRecipeControls(recipeByName("wiggle")!, "Logo", { frequency: 4 });
    expect(plan).toEqual({
      ok: true,
      controls: [
        { key: "frequency", name: "Logo Frequency", kind: "slider", value: 4 },
        { key: "amount", name: "Logo Amount", kind: "slider", value: 20 },
      ],
    });
    expect(planRecipeControls(recipeByName("master_scale")!, undefined, undefined)).toMatchObject({ ok: true, controls: [{ name: "Master Scale", value: 100 }] });
  });

  it("refuses a value for a control the recipe doesn't have, a bad value, or an unsafe prefix", () => {
    expect(planRecipeControls(recipeByName("wiggle")!, undefined, { speed: 1 })).toMatchObject({ ok: false });
    expect(planRecipeControls(recipeByName("tint_color")!, undefined, { color: [2, 0, 0] })).toMatchObject({ ok: false });
    expect(planRecipeControls(recipeByName("wiggle")!, 'a"b', undefined)).toMatchObject({ ok: false });
  });

  it("fills parameter defaults and rejects the wrong ones", () => {
    const loop = recipeByName("loop")!;
    expect(resolveRecipeParams(loop, undefined)).toEqual({ ok: true, params: { loop_type: "cycle", direction: "out", keyframes: 0 } });
    expect(resolveRecipeParams(loop, { loop_type: "pingpong", keyframes: 2 })).toMatchObject({ ok: true, params: { loop_type: "pingpong", keyframes: 2 } });
    expect(resolveRecipeParams(loop, { loop_type: "spin" })).toMatchObject({ ok: false });
    expect(resolveRecipeParams(loop, { keyframes: -1 })).toMatchObject({ ok: false });
    expect(resolveRecipeParams(loop, { colour: "red" })).toMatchObject({ ok: false });
    const ease = recipeByName("ease_between")!;
    expect(resolveRecipeParams(ease, { from: 0 })).toMatchObject({ ok: false, message: expect.stringContaining("to") });
    expect(resolveRecipeParams(ease, { from: [0, 0], to: [100, 50] })).toMatchObject({ ok: true });
    expect(resolveRecipeParams(ease, { from: [0], to: 5 })).toMatchObject({ ok: false });
    expect(resolveRecipeParams(recipeByName("count_up")!, { separator: "toolong" })).toMatchObject({ ok: false });
  });

  it("ae_expr_recipes lists them, one or all, without AE", async () => {
    const all = (await tool("ae_expr_recipes").handler({}, undefined as never)) as { recipes: Array<{ name: string }> };
    expect(all.recipes).toHaveLength(RECIPES.length);
    const one = (await tool("ae_expr_recipes").handler({ recipe: "wiggle" }, undefined as never)) as {
      recipes: Array<{ control_names: Array<{ name: string }> }>;
    };
    expect(one.recipes).toHaveLength(1);
    expect(one.recipes[0].control_names.map((c) => c.name)).toEqual(["Wiggle Frequency", "Wiggle Amount"]);
  });
});

describe("read-back checks", () => {
  const slider = (value: unknown): ControlSpec => ControlSpecSchema.parse({ name: "Speed", kind: "slider", value });

  it("compares control values by kind", () => {
    expect(expectedControlValue(ControlSpecSchema.parse({ name: "On", kind: "checkbox", value: true }))).toBe(1);
    expect(expectedControlValue(ControlSpecSchema.parse({ name: "C", kind: "color", value: [1, 0, 0] }))).toEqual([1, 0, 0, 1]);
    expect(expectedControlValue(ControlSpecSchema.parse({ name: "S", kind: "slider" }))).toBeUndefined();
    expect(valuesMatch(1, true)).toBe(true);
    expect(valuesMatch(0, true)).toBe(false);
    expect(valuesMatch([1, 0, 0, 1], [1, 0, 0, 1])).toBe(true);
    expect(valuesMatch([1, 0, 0, 1], [0.5, 0, 0, 1])).toBe(false);
    expect(valuesMatch(50, 50.0001)).toBe(true);
    expect(valuesMatch(50, "50")).toBe(false);
  });

  it("flags a missing, wrong-kind or wrong-valued control", () => {
    const good = { found: true, name: "Speed", kind: "slider", match_name: "ADBE Slider Control", value: 50 };
    const m1: never[] = [];
    controlMismatches(m1, "c", slider(50), good);
    expect(m1).toEqual([]);
    const m2: Array<{ path: string }> = [];
    controlMismatches(m2, "c", slider(50), { ...good, value: 10 });
    expect(m2.map((x) => x.path)).toEqual(["c.value"]);
    const m3: Array<{ path: string }> = [];
    controlMismatches(m3, "c", slider(50), { found: false, name: "Speed" });
    expect(m3.map((x) => x.path)).toEqual(["c"]);
    const m4: Array<{ path: string }> = [];
    controlMismatches(m4, "c", slider(50), { ...good, kind: "angle", match_name: "ADBE Angle Control" });
    expect(m4.map((x) => x.path)).toEqual(["c.kind", "c.match_name"]);
    const dd = ControlSpecSchema.parse({ name: "Mode", kind: "dropdown", items: ["A", "B"], value: 2 });
    const m5: Array<{ path: string }> = [];
    controlMismatches(m5, "c", dd, { found: true, name: "Mode", kind: "dropdown", match_name: "ADBE Dropdown Control", value: 2, items: ["A", "C"] });
    expect(m5.map((x) => x.path)).toEqual(["c.items"]);
  });

  it("flags an expression that differs, is off, or errors; line breaks don't count", () => {
    const m: Array<{ path: string }> = [];
    expressionMismatches(m, "p", "a\nb", { found: true, expression: "a\r\nb", enabled: true, error: null });
    expect(m).toEqual([]);
    expressionMismatches(m, "p", "a", { found: true, expression: "b", enabled: false, error: "bad" });
    expect(m.map((x) => x.path)).toEqual(["p.expression", "p.expressionEnabled", "p.expressionError"]);
  });

  it("unlink: a property that still has an expression is a mismatch", () => {
    const w = { unlinked: [{ layer_id: 1, path: ["x"] }] };
    expect(unlinkMismatches(w, { props: [{ found: true, expression: "" }], controls: [], scans: [] })).toEqual([]);
    expect(unlinkMismatches(w, { props: [{ found: true, expression: "x" }], controls: [], scans: [] })).toHaveLength(1);
  });

  it("rename: names any expression still on the old name, and any new error", () => {
    const args = { comp_id: 1, layer: { name: "Controls" }, control: "Old", new_name: "New", expect: expectArg };
    const ref = (error: string | null, extra = {}) => ({ layer_id: 1, layer_name: "Box", path: "Opacity", match_path: ["a"], expression: 'effect("Old")(1)', error, ...extra });
    const control = { found: true, name: "New", kind: "slider" };
    const before = {
      props: [],
      controls: [{ found: true, name: "Old", kind: "slider" }],
      scans: [{ found: true, name: "Old", count: 2, references: [ref(null)], truncated: false }],
    };
    const clean = {
      props: [],
      controls: [control],
      scans: [
        { found: true, name: "Old", count: 0, references: [], truncated: false },
        { found: true, name: "New", count: 2, references: [ref(null)], truncated: false },
      ],
    };
    expect(renameMismatches(args, before, clean)).toEqual([]);
    const stale = { ...clean, scans: [{ found: true, name: "Old", count: 1, references: [ref(null)], truncated: false }, clean.scans[1]] };
    const m = renameMismatches(args, before, stale);
    expect(m).toHaveLength(1);
    expect(m[0].message).toContain("still names the old control");
    const fewer = { ...clean, scans: [clean.scans[0], { found: true, name: "New", count: 1, references: [], truncated: false }] };
    expect(renameMismatches(args, before, fewer).map((x) => x.path)).toEqual(["references"]);
    const broken = { ...clean, scans: [clean.scans[0], { found: true, name: "New", count: 2, references: [ref("boom", { expression: 'effect("New")(1)' })], truncated: false }] };
    expect(renameMismatches(args, before, broken)[0].message).toContain("expression error");
    // An error that was already there before the rename is not the rename's doing.
    const wasBroken = { ...before, scans: [{ ...before.scans[0], references: [ref("boom")] }] };
    expect(renameMismatches(args, wasBroken, broken)).toEqual([]);
    expect(renameMismatches(args, before, { ...clean, controls: [{ found: false, name: "New" }] })[0].path).toBe("control");
  });
});

// ---------- the guarded flow ----------

describe("rig tools with a scripted bridge", () => {
  const afterControl = { found: true, layer_id: 7, name: "Speed", kind: "slider", match_name: "ADBE Slider Control", value: 50 };

  it("ae_rig_add_controls: guard, read, write, read back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      rigState: [
        { props: [], controls: [{ found: false, name: "Speed" }], scans: [] },
        { props: [], controls: [afterControl], scans: [] },
      ],
      rigAddControls: [{ layer: { index: 2, id: 7, name: "Controls" }, created_layer: false, controls: [{ name: "Speed", kind: "slider" }] }],
    });
    const args = AeRigAddControlsSchema.parse({
      comp_id: 1,
      layer: { name: "Controls" },
      controls: [{ name: "Speed", kind: "slider", value: 50 }],
      expect: expectArg,
    });
    const out = (await tool("ae_rig_add_controls").handler(args, ctx)) as { receipt: { matches: boolean }; layer: { id: number } };
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "rigState", "rigAddControls", "rigState"]);
    expect(calls[2].script).toContain('"expect"');
    expect(calls[3].script).toContain('"id":7');
    expect(out.receipt.matches).toBe(true);
    expect(out.layer.id).toBe(7);
  });

  it("ae_rig_add_controls: a wrong value in the read-back lands in the receipt", async () => {
    const { ctx } = fakeAe({
      rigState: [
        { props: [], controls: [], scans: [] },
        { props: [], controls: [{ ...afterControl, value: 3 }], scans: [] },
      ],
      rigAddControls: [{ layer: { index: 2, id: 7, name: "Controls" }, created_layer: false, controls: [] }],
    });
    const args = AeRigAddControlsSchema.parse({ comp_id: 1, layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider", value: 50 }], expect: expectArg });
    const out = (await tool("ae_rig_add_controls").handler(args, ctx)) as { receipt: { matches: boolean; mismatches: Array<{ path: string }> } };
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m) => m.path)).toEqual(["controls[0].value"]);
  });

  it("ae_rig_link: a read-back that fails after the write is reported, not thrown", async () => {
    const link = { layer_id: 5, path: ["ADBE Transform Group", "ADBE Opacity"], expression: 'effect("Speed")(1)', control: { layer_id: 5, name: "Speed" } };
    const { ctx, calls } = fakeAe(
      { rigState: [{ props: [{ found: true, expression: "" }], controls: [], scans: [] }], rigLink: [{ links: [link] }] },
      { failOn: "rigState#2" }
    );
    const args = AeRigLinkSchema.parse({
      comp_id: 1,
      links: [{ layer: { name: "Box" }, path: link.path, control: { name: "Speed" } }],
      expect: expectArg,
    });
    const out = (await tool("ae_rig_link").handler(args, ctx)) as { applied: boolean; receipt: { matches: boolean; mismatches: Array<{ message: string }> } };
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "rigState", "rigLink", "rigState"]);
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].message).toContain("Do not resend");
  });

  it("ae_rig_link: an expression error read back is a mismatch", async () => {
    const link = { layer_id: 5, path: ["ADBE Transform Group", "ADBE Opacity"], expression: 'effect("Speed")(1)', control: { layer_id: 5, name: "Speed" } };
    const { ctx } = fakeAe({
      rigState: [
        { props: [{ found: true, expression: "" }], controls: [], scans: [] },
        { props: [{ found: true, expression: 'effect("Speed")(1)', enabled: true, error: "Effect named \"Speed\" is missing" }], controls: [], scans: [] },
      ],
      rigLink: [{ links: [link] }],
    });
    const args = AeRigLinkSchema.parse({ comp_id: 1, links: [{ layer: { name: "Box" }, path: link.path, control: { name: "Speed" } }], expect: expectArg });
    const out = (await tool("ae_rig_link").handler(args, ctx)) as { receipt: { mismatches: Array<{ path: string }> } };
    expect(out.receipt.mismatches.map((m) => m.path)).toEqual(["links[0].expressionError"]);
  });

  it("ae_rig_rename: reads the old name's references before, both names after", async () => {
    const { ctx, calls } = fakeAe({
      rigState: [
        { props: [], controls: [{ found: true, name: "Old", kind: "slider" }], scans: [{ found: true, name: "Old", count: 1, references: [], truncated: false }] },
        {
          props: [],
          controls: [{ found: true, name: "New", kind: "slider" }],
          scans: [
            { found: true, name: "Old", count: 0, references: [], truncated: false },
            { found: true, name: "New", count: 1, references: [], truncated: false },
          ],
        },
      ],
      rigRename: [{ layer: { index: 2, id: 7, name: "Controls" }, old_name: "Old", new_name: "New", references_before: 1, autofix: "not needed" }],
    });
    const args = AeRigRenameSchema.parse({ comp_id: 1, layer: { name: "Controls" }, control: "Old", new_name: "New", expect: expectArg });
    const out = (await tool("ae_rig_rename").handler(args, ctx)) as { receipt: { matches: boolean } };
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "rigState", "rigRename", "rigState"]);
    expect(calls[3].script).toContain('"name":"Old"');
    expect(calls[3].script).toContain('"name":"New"');
    expect(out.receipt.matches).toBe(true);
  });

  it("ae_rig_rename: a capped scan keeps the receipt clean but adds scan_truncated and a warning", async () => {
    const mk = (truncated: boolean) => fakeAe({
      rigState: [
        { props: [], controls: [{ found: true, name: "Old", kind: "slider" }], scans: [{ found: true, name: "Old", count: 0, references: [], truncated: false }], scan_truncated: truncated },
        {
          props: [],
          controls: [{ found: true, name: "New", kind: "slider" }],
          scans: [
            { found: true, name: "Old", count: 0, references: [], truncated: false },
            { found: true, name: "New", count: 0, references: [], truncated: false },
          ],
          scan_truncated: truncated,
        },
      ],
      rigRename: [{ layer: { index: 2, id: 7, name: "Controls" }, old_name: "Old", new_name: "New", references_before: 0, autofix: "not needed", scan_truncated: truncated }],
    });
    const args = AeRigRenameSchema.parse({ comp_id: 1, layer: { name: "Controls" }, control: "Old", new_name: "New", expect: expectArg });
    type Out = { receipt: { matches: boolean }; scan_truncated?: boolean; warning?: string };
    const capped = (await tool("ae_rig_rename").handler(args, mk(true).ctx)) as Out;
    expect(capped.receipt.matches).toBe(true);
    expect(capped.scan_truncated).toBe(true);
    expect(capped.warning).toContain("capped");
    const plain = (await tool("ae_rig_rename").handler(args, mk(false).ctx)) as Out;
    expect(plain.receipt.matches).toBe(true);
    expect(plain.warning).toBeUndefined();
  });

  it("ae_rig_unlink and ae_expr_recipe follow the same flow", async () => {
    const u = fakeAe({
      rigState: [{ props: [{ found: true, expression: "x" }], controls: [], scans: [] }, { props: [{ found: true, expression: "" }], controls: [], scans: [] }],
      rigUnlink: [{ unlinked: [{ layer_id: 5, path: ["Opacity"] }], skipped: [] }],
    });
    const uArgs = AeRigUnlinkSchema.parse({ comp_id: 1, targets: [{ layer: { name: "Box" }, path: ["Opacity"] }], expect: expectArg });
    const uOut = (await tool("ae_rig_unlink").handler(uArgs, u.ctx)) as { receipt: { matches: boolean } };
    expect(u.calls.map((c) => c.fn)).toEqual(["checkGuard", "rigState", "rigUnlink", "rigState"]);
    expect(uOut.receipt.matches).toBe(true);

    const expr = "wiggle(effect(\"Wiggle Frequency\")(1), effect(\"Wiggle Amount\")(1));";
    const control = (name: string, value: number) => ({ found: true, layer_id: 5, name, kind: "slider", match_name: "ADBE Slider Control", value });
    const r = fakeAe({
      rigState: [
        { props: [{ found: true, expression: "" }], controls: [], scans: [] },
        { props: [{ found: true, expression: expr, enabled: true, error: null }], controls: [control("Wiggle Frequency", 2), control("Wiggle Amount", 20)], scans: [] },
      ],
      rigRecipe: [
        {
          recipe: "wiggle",
          target: { layer_id: 5, path: ["ADBE Transform Group", "ADBE Position"] },
          controls: [
            { layer_id: 5, name: "Wiggle Frequency", kind: "slider", key: "frequency" },
            { layer_id: 5, name: "Wiggle Amount", kind: "slider", key: "amount" },
          ],
          controls_created: ["Wiggle Frequency", "Wiggle Amount"],
          expression: expr,
        },
      ],
    });
    const rArgs = AeExprRecipeSchema.parse({ comp_id: 1, layer: { name: "Box" }, path: ["ADBE Transform Group", "ADBE Position"], recipe: "wiggle", expect: expectArg });
    const rOut = (await tool("ae_expr_recipe").handler(rArgs, r.ctx)) as { receipt: { matches: boolean } };
    expect(r.calls.map((c) => c.fn)).toEqual(["checkGuard", "rigState", "rigRecipe", "rigState"]);
    expect(r.calls[2].script).toContain('"Wiggle Frequency"');
    expect(rOut.receipt.matches).toBe(true);
  });

  it("ae_expr_recipe refuses bad parameters, a missing source and unknown control values before touching AE", async () => {
    const { ctx, calls } = fakeAe({});
    const base = { comp_id: 1, layer: { name: "Box" }, path: ["Opacity"], expect: expectArg };
    const go = (extra: object) => tool("ae_expr_recipe").handler(AeExprRecipeSchema.parse({ ...base, ...extra }), ctx);
    expect(await go({ recipe: "loop", params: { loop_type: "spin" } })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await go({ recipe: "follow_delay" })).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("source") });
    expect(await go({ recipe: "wiggle", source: { name: "x" } })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await go({ recipe: "wiggle", values: { nope: 1 } })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await go({ recipe: "ease_between" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(calls).toEqual([]);
  });

  it("ae_rig_list calls the host as a read", async () => {
    const { ctx, calls } = fakeAe({ rigList: [{ comp_id: 1, controls: [], truncated: false }] });
    const out = await tool("ae_rig_list").handler(AeRigListSchema.parse({ comp_id: 1, include_references: false }), ctx);
    expect(out).toMatchObject({ comp_id: 1 });
    expect(calls.map((c) => c.fn)).toEqual(["rigList"]);
    expect(calls[0].script).toContain('"include_references":false');
  });
});

// ---------- the host under node:vm ----------

describe("rig.jsx: adding controls", () => {
  it("adds every kind with its value, on a layer, in one undo group", () => {
    const s = scene();
    const out = run(s, "rigAddControls", {
      layer: { name: "Controls" },
      controls: [
        { name: "Speed", kind: "slider", value: 50 },
        { name: "Spin", kind: "angle", value: 90 },
        { name: "Show", kind: "checkbox", value: true },
        { name: "Tint", kind: "color", value: [0, 0.5, 1] },
        { name: "Center", kind: "point", value: [10, 20] },
        { name: "Depth", kind: "point3d", value: [1, 2, 3] },
        { name: "Target", kind: "layer", layer: { name: "Box" } },
        { name: "Mode", kind: "dropdown", items: ["Off", "(-", "On", "Auto"], value: 3 },
      ],
    });
    expect(out.created_layer).toBe(false);
    expect(out.controls.map((c: { name: string }) => c.name)).toEqual(["Speed", "Spin", "Show", "Tint", "Center", "Depth", "Target", "Mode"]);
    expect(out.controls.map((c: { index: number }) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const fx = effectsOf(s.ctl);
    const val = (i: number) => (fx[i] as FakeGroup).property(1) as FakeProperty;
    expect(fx.map((f) => f.matchName)).toEqual([
      "ADBE Slider Control",
      "ADBE Angle Control",
      "ADBE Checkbox Control",
      "ADBE Color Control",
      "ADBE Point Control",
      "ADBE Point3D Control",
      "ADBE Layer Control",
      "ADBE Dropdown Control",
    ]);
    expect(val(0).staticValue).toBe(50);
    expect(val(1).staticValue).toBe(90);
    expect(val(2).staticValue).toBe(1);
    expect(val(3).staticValue).toEqual([0, 0.5, 1, 1]);
    expect(val(4).staticValue).toEqual([10, 20]);
    expect(val(5).staticValue).toEqual([1, 2, 3]);
    expect(val(6).staticValue).toBe(s.box.index);
    expect(val(7).staticValue).toBe(3);
    expect((val(7) as unknown as { propertyParameters: string[] }).propertyParameters).toEqual(["Off", "(-", "On", "Auto"]);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
  });

  it("refuses bad input before opening an undo group", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }] });
    s.undo.begun = 0;
    s.undo.ended = 0;
    const bad = (controls: unknown[], layer: unknown = { name: "Controls" }) => fails(s, "rigAddControls", { layer, controls });
    expect(bad([{ name: "Speed", kind: "slider" }])).toMatchObject({ kind: "bad_args", message: expect.stringContaining("already has an effect") });
    expect(bad([{ name: "A", kind: "slider" }, { name: "A", kind: "angle" }]).message).toContain("given twice");
    expect(bad([{ name: 'Q"', kind: "slider" }]).message).toContain("quote");
    expect(bad([{ name: "X", kind: "slider", value: "5" }]).message).toContain("number");
    expect(bad([{ name: "X", kind: "color", value: [0, 2, 0] }]).message).toContain("0..1");
    expect(bad([{ name: "X", kind: "dropdown", items: ["A", "A"] }]).message).toContain("twice");
    expect(bad([{ name: "X", kind: "dropdown", items: ["A", "B\\C"] }]).message).toContain("backslash");
    expect(bad([{ name: "X", kind: "dropdown", items: ["A", "B"], value: 3 }]).message).toContain("item number");
    expect(bad([{ name: "X", kind: "slider", items: ["A"] }]).message).toContain("dropdown");
    expect(bad([{ name: "X", kind: "bogus" }]).message).toContain("Unknown control kind");
    expect(bad([{ name: "X", kind: "slider" }], { name: "Nope" })).toMatchObject({ kind: "not_found" });
    expect(bad([])).toMatchObject({ kind: "bad_args" });
    expect(s.undo).toEqual({ begun: 0, ended: 0 });
    expect(effectsOf(s.ctl)).toHaveLength(1);
  });

  it("refuses a layer that can't hold effects and a failing guard", () => {
    const s = scene();
    const cam = s.comp.layers.addCamera("Cam") as FakeLayer;
    (cam.group.props[2] as FakeGroup).matchName = "ADBE Not Effects";
    expect(fails(s, "rigAddControls", { layer: { name: "Cam" }, controls: [{ name: "X", kind: "slider" }] }).message).toContain("can't hold effects");
    expect(fails(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "X", kind: "slider" }], expect: { project_path: "/elsewhere.aep" } }).kind).toBe("guard");
    expect(fails(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "X", kind: "slider" }], expect: undefined }).kind).toBe("guard");
  });

  it("takes back what it added when a later control fails", () => {
    const s = scene();
    sim.dropdownFails = true;
    expect(() =>
      s.A.rigAddControls({
        comp_id: s.comp.id,
        expect: GUARD,
        layer: { name: "Controls" },
        controls: [
          { name: "Speed", kind: "slider", value: 5 },
          { name: "Mode", kind: "dropdown", items: ["A", "B"] },
        ],
      })
    ).toThrow("setPropertyParameters failed");
    expect(effectsOf(s.ctl)).toHaveLength(0);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
  });

  it("makes a null for the controls when asked and none has the name", () => {
    const s = scene();
    const before = s.comp.numLayers;
    const out = run(s, "rigAddControls", { layer: { name: "Rig" }, create_if_missing: true, controls: [{ name: "Speed", kind: "slider" }] });
    expect(out.created_layer).toBe(true);
    expect(s.comp.numLayers).toBe(before + 1);
    expect(s.comp.layer("Rig")).toBeTruthy();
    expect(effectsOf(s.comp.layer("Rig") as FakeLayer)).toHaveLength(1);
    // Now it exists: used as is, no second null.
    const again = run(s, "rigAddControls", { layer: { name: "Rig" }, create_if_missing: true, controls: [{ name: "Other", kind: "angle" }] });
    expect(again.created_layer).toBe(false);
    expect(s.comp.numLayers).toBe(before + 1);
    expect(fails(s, "rigAddControls", { layer: { index: 1 }, create_if_missing: true, controls: [{ name: "Z", kind: "slider" }] }).message).toContain("by name");
  });

  it("removes the null it made when the controls fail", () => {
    const s = scene();
    sim.dropdownFails = true;
    const before = s.comp.numLayers;
    expect(() =>
      s.A.rigAddControls({ comp_id: s.comp.id, expect: GUARD, layer: { name: "Rig" }, create_if_missing: true, controls: [{ name: "M", kind: "dropdown", items: ["A"] }] })
    ).toThrow();
    expect(s.comp.numLayers).toBe(before);
    expect(s.comp.layer("Rig")).toBeNull();
  });

  it("refuses a dropdown on an AE older than 17.0.1", () => {
    const s = scene();
    const project = s.project;
    const old = loadHost(project, ["rig.jsx"], { version: "16.1.3" });
    expect(() =>
      old.A.rigAddControls({ comp_id: s.comp.id, expect: GUARD, layer: { name: "Controls" }, controls: [{ name: "M", kind: "dropdown", items: ["A"] }] })
    ).toThrow("17.0.1");
  });
});

describe("rig.jsx: linking", () => {
  function withControls() {
    const s = scene();
    run(s, "rigAddControls", {
      layer: { name: "Controls" },
      controls: [
        { name: "Speed", kind: "slider", value: 50 },
        { name: "Spin", kind: "angle" },
        { name: "Show", kind: "checkbox" },
        { name: "Tint", kind: "color" },
        { name: "Center", kind: "point" },
        { name: "Depth", kind: "point3d" },
        { name: "Mode", kind: "dropdown", items: ["A", "B"] },
        { name: "Pick", kind: "layer" },
      ],
    });
    s.undo.begun = 0;
    s.undo.ended = 0;
    return s;
  }
  const link = (s: Scene, spec: Record<string, unknown>, layer = "Box", path = OPACITY, extra: Record<string, unknown> = {}) =>
    run(s, "rigLink", { links: [{ layer: { name: layer }, path, ...spec }], ...extra });

  it("reads a control with index 1, from another layer by name and from its own layer without one", () => {
    const s = withControls();
    const out = link(s, { control: { name: "Speed", layer: { name: "Controls" } } });
    expect(out.links[0].expression).toBe('thisComp.layer("Controls").effect("Speed")(1)');
    expect(propOf(s.box, ...OPACITY).expression).toBe('thisComp.layer("Controls").effect("Speed")(1)');
    expect(out.links[0]).toMatchObject({ dims: "1d", control: { name: "Speed", kind: "slider" } });
    run(s, "rigAddControls", { layer: { name: "Box" }, controls: [{ name: "Own", kind: "slider" }] });
    const own = link(s, { control: { name: "Own" } }, "Box", ROT);
    expect(own.links[0].expression).toBe('effect("Own")(1)');
    expect(s.undo.begun).toBe(3);
    expect(s.undo.begun).toBe(s.undo.ended);
  });

  it("never uses a parameter's display name", () => {
    const s = withControls();
    const out = link(s, { control: { name: "Speed", layer: { name: "Controls" } } });
    expect(out.links[0].expression).not.toMatch(/"Slider"/);
  });

  it("remaps with linear() (clamped) or a straight line, and multiplies", () => {
    const s = withControls();
    const ctl = { name: "Speed", layer: { name: "Controls" } };
    const ref = 'thisComp.layer("Controls").effect("Speed")(1)';
    expect(link(s, { control: ctl, remap: { in_min: 0, in_max: 100, out_min: 0, out_max: 360 } }).links[0].expression).toBe(`linear(${ref}, 0, 100, 0, 360)`);
    expect(link(s, { control: ctl, remap: { in_min: 0, in_max: 100, out_min: 10, out_max: 20 }, multiplier: 2 }, "Box", OPACITY, { replace: true }).links[0].expression).toBe(
      `linear(${ref}, 0, 100, 10, 20) * 2`
    );
    expect(link(s, { control: ctl, remap: { in_min: 0, in_max: 10, out_min: 0, out_max: 100, clamp: false } }, "Box", OPACITY, { replace: true }).links[0].expression).toBe(
      `(0 + (${ref} - 0) * 10)`
    );
    expect(link(s, { control: ctl, multiplier: 0.5 }, "Box", OPACITY, { replace: true }).links[0].expression).toBe(`${ref} * 0.5`);
  });

  it("a slider on a 3D property drives every component, or one with axis", () => {
    const s = withControls();
    const ctl = { name: "Speed", layer: { name: "Controls" } };
    const ref = 'thisComp.layer("Controls").effect("Speed")(1)';
    const all = link(s, { control: ctl }, "Box", SCALE);
    expect(all.links[0]).toMatchObject({ dims: "3d", expression: `var s = ${ref};\n[s, s, s]` });
    const one = link(s, { control: ctl, axis: 1 }, "Box", SCALE, { replace: true });
    expect(one.links[0].expression).toBe(`var s = ${ref};\n[value[0], s, value[2]]`);
    const flat = addSize(s.box);
    expect(link(s, { control: ctl }, "Box", flat).links[0].expression).toBe(`var s = ${ref};\n[s, s]`);
    expect(fails(s, "rigLink", { links: [{ layer: { name: "Box" }, path: flat, control: ctl, axis: 2 }], replace: true }).message).toContain("axis");
    expect(fails(s, "rigLink", { links: [{ layer: { name: "Box" }, path: OPACITY, control: ctl, axis: 0 }], replace: true }).message).toContain("2D and 3D");
  });

  it("matches colour, point and 3D point controls to the property's dimensions", () => {
    const s = withControls();
    const c = (name: string) => ({ name, layer: { name: "Controls" } });
    const ref = (name: string) => `thisComp.layer("Controls").effect("${name}")(1)`;
    const fill = addColor(s.box);
    expect(link(s, { control: c("Tint") }, "Box", fill).links[0]).toMatchObject({ dims: "color", expression: ref("Tint") });
    expect(link(s, { control: c("Center") }, "Box", POS).links[0].expression).toBe(`var p = ${ref("Center")};\n[p[0], p[1], value[2]]`);
    expect(link(s, { control: c("Depth") }, "Box", POS, { replace: true }).links[0].expression).toBe(ref("Depth"));
    const flat = addSize(s.box);
    expect(link(s, { control: c("Center") }, "Box", flat).links[0].expression).toBe(ref("Center"));
    expect(link(s, { control: c("Depth") }, "Box", flat, { replace: true }).links[0].expression).toBe(`var p = ${ref("Depth")};\n[p[0], p[1]]`);
    expect(link(s, { control: c("Center"), multiplier: 2 }, "Box", flat, { replace: true }).links[0].expression).toBe(`${ref("Center")} * 2`);
    // Checkbox and dropdown read as numbers.
    expect(link(s, { control: c("Show") }, "Box", ROT).links[0].expression).toBe(ref("Show"));
    expect(link(s, { control: c("Mode"), remap: { in_min: 1, in_max: 2, out_min: 0, out_max: 100 } }, "Box", OPACITY).links[0].expression).toBe(
      `linear(${ref("Mode")}, 1, 2, 0, 100)`
    );
  });

  it("refuses pairings that make no sense, and changes nothing", () => {
    const s = withControls();
    const c = (name: string) => ({ name, layer: { name: "Controls" } });
    const fill = addColor(s.box);
    const flat = addSize(s.box);
    const bad = (spec: Record<string, unknown>, path: string[]) => fails(s, "rigLink", { links: [{ layer: { name: "Box" }, path, ...spec }] });
    expect(bad({ control: c("Speed") }, fill).message).toContain("colour");
    expect(bad({ control: c("Tint") }, OPACITY).message).toContain("colour properties only");
    expect(bad({ control: c("Tint"), multiplier: 2 }, fill).message).toContain("multiplier");
    expect(bad({ control: c("Center") }, OPACITY).message).toContain("2D and 3D");
    expect(bad({ control: c("Depth") }, OPACITY).message).toContain("3D properties");
    expect(bad({ control: c("Center"), remap: { in_min: 0, in_max: 1, out_min: 0, out_max: 1 } }, flat).message).toContain("remap");
    expect(bad({ control: c("Pick") }, OPACITY).message).toContain("layer-picker");
    expect(bad({ control: { name: "Nope", layer: { name: "Controls" } } }, OPACITY)).toMatchObject({ kind: "not_found" });
    expect(bad({ control: { name: "Speed", layer: { name: "Controls" } } }, ["ADBE Transform Group"]).message).toContain("group");
    expect(bad({ control: { name: "Speed", layer: { name: "Controls" } } }, ["ADBE Transform Group", "ADBE Nope"])).toMatchObject({ kind: "not_found" });
    expect(bad({ control: { name: "Speed" } }, OPACITY)).toMatchObject({ kind: "not_found" });
    expect(bad({ control: c("Speed"), remap: { in_min: 3, in_max: 3, out_min: 0, out_max: 1 } }, OPACITY).message).toContain("differ");
    expect(s.undo.begun).toBe(0);
    expect(propOf(s.box, ...OPACITY).expression).toBe("");
  });

  it("protects an existing expression unless replace is set, and a property named twice", () => {
    const s = withControls();
    const ctl = { name: "Speed", layer: { name: "Controls" } };
    propOf(s.box, ...OPACITY).expression = "time * 10";
    const out = fails(s, "rigLink", { links: [{ layer: { name: "Box" }, path: OPACITY, control: ctl }] });
    expect(out.message).toContain("replace: true");
    expect(propOf(s.box, ...OPACITY).expression).toBe("time * 10");
    const replaced = link(s, { control: ctl }, "Box", OPACITY, { replace: true });
    expect(replaced.links[0].previous_expression).toBe("time * 10");
    expect(fails(s, "rigLink", { replace: true, links: [{ layer: { name: "Box" }, path: OPACITY, control: ctl }, { layer: { index: s.box.index }, path: OPACITY, control: ctl }] }).message).toContain("twice");
  });

  it("warns when keyframes sit under the new expression", () => {
    const s = withControls();
    propOf(s.box, ...OPACITY).setValueAtTime(0, 0);
    propOf(s.box, ...OPACITY).setValueAtTime(1, 100);
    const out = link(s, { control: { name: "Speed", layer: { name: "Controls" } } });
    expect(out.links[0].warnings[0]).toContain("keyframes");
  });

  it("won't name a layer whose name is shared or holds a quote", () => {
    const s = withControls();
    const dup = s.comp.layers.addNull(4) as FakeLayer;
    dup.name = "Controls";
    expect(fails(s, "rigLink", { links: [{ layer: { name: "Box" }, path: OPACITY, control: { name: "Speed", layer: { index: s.ctl.index } } }] }).message).toContain("tell them apart");
    dup.remove();
    s.ctl.name = 'Co"ntrols';
    expect(fails(s, "rigLink", { links: [{ layer: { name: "Box" }, path: OPACITY, control: { name: "Speed", layer: { index: s.ctl.index } } }] }).message).toContain("quote");
  });

  it("puts the expressions back when one fails to set", () => {
    const s = withControls();
    const ctl = { name: "Speed", layer: { name: "Controls" } };
    propOf(s.box, ...ROT).expression = "time";
    sim.rejectExpr = (v) => v.includes("effect(") && propOf(s.box, ...OPACITY).expression !== "" && v.includes("(1)") && v.startsWith("thisComp") && propOf(s.box, ...OPACITY).expression.length > 0;
    // Opacity takes the link; Rotation is rejected.
    sim.rejectExpr = (v) => v === 'thisComp.layer("Controls").effect("Spin")(1)';
    expect(() =>
      s.A.rigLink({
        comp_id: s.comp.id,
        expect: GUARD,
        replace: true,
        links: [
          { layer: { name: "Box" }, path: OPACITY, control: ctl },
          { layer: { name: "Box" }, path: ROT, control: { name: "Spin", layer: { name: "Controls" } } },
        ],
      })
    ).toThrow("syntax");
    sim.rejectExpr = null;
    expect(propOf(s.box, ...OPACITY).expression).toBe("");
    expect(propOf(s.box, ...ROT).expression).toBe("time");
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
  });
});

describe("rig.jsx: unlinking", () => {
  it("clears expressions, and skips what doesn't name the control", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }] });
    propOf(s.box, ...OPACITY).expression = 'thisComp.layer("Controls").effect("Speed")(1)';
    propOf(s.box, ...ROT).expression = "time * 5";
    const none = addColor(s.box);
    s.undo.begun = 0;
    s.undo.ended = 0;
    const out = run(s, "rigUnlink", {
      targets: [
        { layer: { name: "Box" }, path: OPACITY, control_name: "Speed" },
        { layer: { name: "Box" }, path: ROT, control_name: "Speed" },
        { layer: { name: "Box" }, path: none },
      ],
    });
    expect(out.unlinked).toHaveLength(1);
    expect(out.unlinked[0].path).toEqual(OPACITY);
    expect(out.skipped.map((x: { reason: string }) => x.reason)).toEqual(["its expression does not name the control \"Speed\"", "has no expression"]);
    expect(propOf(s.box, ...OPACITY).expression).toBe("");
    expect(propOf(s.box, ...ROT).expression).toBe("time * 5");
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    expect(fails(s, "rigUnlink", { targets: [{ layer: { name: "Box" }, path: OPACITY }, { layer: { name: "Box" }, path: OPACITY }] }).message).toContain("twice");
  });
});

describe("rig.jsx: renaming", () => {
  function referenced(opts: { autoFix?: boolean } = {}) {
    const s = scene(opts);
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }, { name: "Other", kind: "slider" }] });
    propOf(s.box, ...OPACITY).expression = 'thisComp.layer("Controls").effect("Speed")(1) * 2';
    propOf(s.ctl, ...ROT).expression = 'effect("Speed")(1)';
    // Another layer's own effect with the same name is not a reference to ours.
    run(s, "rigAddControls", { layer: { name: "Box" }, controls: [{ name: "Speed", kind: "slider" }] });
    propOf(s.box, ...ROT).expression = 'effect("Speed")(1)';
    s.undo.begun = 0;
    s.undo.ended = 0;
    return s;
  }

  it("renames, then repairs the quoted references that AE left broken", () => {
    const s = referenced();
    const out = run(s, "rigRename", { layer: { name: "Controls" }, control: "Speed", new_name: "Gain" });
    expect(effectsOf(s.ctl).map((f) => f.name)).toEqual(["Gain", "Other"]);
    expect(out).toMatchObject({ old_name: "Speed", new_name: "Gain", references_before: 2, references_left_after_rename: 2, autofix: "attempted", autofix_calls: 2 });
    expect(s.fixes[0]).toEqual(['effect("Speed")', 'effect("Gain")']);
    expect(propOf(s.box, ...OPACITY).expression).toBe('thisComp.layer("Controls").effect("Gain")(1) * 2');
    expect(propOf(s.ctl, ...ROT).expression).toBe('effect("Gain")(1)');
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    // The read-back finds nothing on the old name and both references on the new.
    const state = run(s, "rigState", { controls: [{ layer: { name: "Controls" }, name: "Gain" }], scans: [{ layer: { name: "Controls" }, name: "Speed" }, { layer: { name: "Controls" }, name: "Gain" }] });
    expect(state.scans[0].count).toBe(0);
    expect(state.scans[1].count).toBe(2);
    expect(state.scans[1].references.every((r: { error: unknown }) => r.error === null)).toBe(true);
  });

  it("with no autoFixExpressions it says so and leaves the references for the read-back to find", () => {
    const s = referenced({ autoFix: false });
    const out = run(s, "rigRename", { layer: { name: "Controls" }, control: "Speed", new_name: "Gain" });
    expect(out.autofix).toBe("unavailable");
    const state = run(s, "rigState", { scans: [{ layer: { name: "Controls" }, name: "Speed" }] });
    expect(state.scans[0].count).toBe(2);
    expect(state.scans[0].references[0].error).toContain("missing");
  });

  it("needs no repair when nothing names it", () => {
    const s = referenced();
    const out = run(s, "rigRename", { layer: { name: "Controls" }, control: "Other", new_name: "Misc" });
    expect(out).toMatchObject({ references_before: 0, autofix: "not needed", autofix_calls: 0 });
    expect(s.fixes).toEqual([]);
  });

  it("refuses a taken or unsafe name, a missing control and a non-control effect", () => {
    const s = referenced();
    const bad = (control: string, new_name: string) => fails(s, "rigRename", { layer: { name: "Controls" }, control, new_name });
    expect(bad("Speed", "Other").message).toContain("already has an effect");
    expect(bad("Speed", 'a"b').message).toContain("quote");
    expect(bad("Speed", "Speed").message).toContain("current name");
    expect(bad("Nope", "X")).toMatchObject({ kind: "not_found" });
    effectsOf(s.ctl).push(Object.assign(new FakeGroup("Blur", "ADBE Gaussian Blur 2", []), { propertyIndex: 3 }));
    expect(bad("Blur", "X").message).toContain("not an Expression Control");
    expect(s.undo.begun).toBe(0);
  });
});

describe("rig.jsx: reads", () => {
  it("rigState reports what is there and what is not, without throwing or changing anything", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider", value: 5 }, { name: "Mode", kind: "dropdown", items: ["A", "B"], value: 2 }] });
    propOf(s.box, ...OPACITY).expression = 'effect("Gone")(1)';
    s.undo.begun = 0;
    s.undo.ended = 0;
    s.comp.time = 1.5;
    const out = run(s, "rigState", {
      props: [
        { layer: { name: "Box" }, path: OPACITY },
        { layer: { name: "Box" }, path: ["ADBE Nope"] },
        { layer: { name: "Missing" }, path: OPACITY },
      ],
      controls: [
        { layer: { name: "Controls" }, name: "Speed" },
        { layer: { name: "Controls" }, name: "Mode" },
        { layer: { name: "Controls" }, name: "Nope" },
      ],
    });
    expect(out.props[0]).toMatchObject({ found: true, dims: "1d", enabled: true, expression: 'effect("Gone")(1)' });
    expect(out.props[0].error).toContain("missing");
    expect(out.props[1]).toMatchObject({ found: false });
    expect(out.props[2]).toMatchObject({ found: false });
    expect(out.controls[0]).toMatchObject({ found: true, kind: "slider", match_name: "ADBE Slider Control", value: 5 });
    expect(out.controls[1]).toMatchObject({ kind: "dropdown", value: 2, items: ["A", "B"] });
    expect(out.controls[2]).toMatchObject({ found: false });
    expect(s.undo).toEqual({ begun: 0, ended: 0 });
    expect(s.comp.time).toBe(1.5);
  });

  it("rigList lists controls with the expressions that name them, and reads no undo group", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }, { name: "Spare", kind: "angle" }] });
    propOf(s.box, ...OPACITY).expression = 'thisComp.layer("Controls").effect("Speed")(1)';
    propOf(s.box, ...ROT).expression = 'effect("Speed")(1)';
    s.undo.begun = 0;
    s.undo.ended = 0;
    const out = run(s, "rigList", { comp_id: s.comp.id });
    expect(out.controls.map((c: { name: string }) => c.name)).toEqual(["Speed", "Spare"]);
    expect(out.controls[0].references_count).toBe(1);
    expect(out.controls[0].references[0]).toMatchObject({ layer_name: "Box", path: "Transform > Opacity", error: null, match_path: ["ADBE Transform Group", "ADBE Opacity"] });
    expect(out.controls[1].references_count).toBe(0);
    expect(out.expression_engine).toBe("javascript-1.0");
    expect(out.references_by).toContain("text search");
    expect(s.undo).toEqual({ begun: 0, ended: 0 });
    const only = run(s, "rigList", { layer: { name: "Box" } });
    expect(only.controls).toEqual([]);
    const bare = run(s, "rigList", { include_references: false });
    expect(bare.controls[0].references).toBeUndefined();
  });
});

// ---------- recipes ----------

/** Runs generated expression text as AE would, with stubs for the expression globals. */
function evalExpr(expr: string, controls: Record<string, unknown>, env: Record<string, unknown> = {}) {
  const lookup = (n: string) => (i: number) => {
    expect(i).toBe(1);
    return controls[n];
  };
  const layerObj = (extra: Record<string, unknown> = {}) =>
    Object.assign((k1: string) => (k2: string) => ({ valueAtTime: (t: number) => `${k1}/${k2}@${t.toFixed(2)}` }), { effect: lookup }, extra);
  const clampTo = (t: number, a: number, b: number) => Math.min(Math.max(t, a), b);
  const ctx = {
    effect: lookup,
    thisComp: { layer: () => layerObj(), frameDuration: 0.04 },
    linear: (t: number, a: number, b: number, c: number, d: number) => c + ((d - c) * clampTo((t - a) / (b - a), 0, 1)),
    ease: (t: number, a: number, b: number, c: number, d: number) => {
      const k = clampTo((t - a) / (b - a), 0, 1);
      return c + (d - c) * (k * k * (3 - 2 * k));
    },
    wiggle: (f: number, a: number) => `wiggle(${f},${a})`,
    loopOut: (type: string, n: number) => `loopOut(${type},${n})`,
    loopIn: (type: string, n: number) => `loopIn(${type},${n})`,
    value: 50,
    time: 1,
    inPoint: 0,
    outPoint: 4,
    numKeys: 0,
    hasParent: false,
    ...env,
  };
  return vm.runInNewContext(expr, ctx);
}

describe("rig.jsx: recipes", () => {
  function recipeScene() {
    const s = scene();
    return s;
  }
  const apply = (s: Scene, recipe: string, extra: Record<string, unknown> = {}, layer = "Box", pathArg: string[] = OPACITY) => {
    const info = recipeByName(recipe)!;
    const params = resolveRecipeParams(info, extra.params as never);
    if (!params.ok) throw new Error(params.message);
    const plan = planRecipeControls(info, extra.name_prefix as string | undefined, extra.values as never);
    if (!plan.ok) throw new Error(plan.message);
    return {
      args: {
        layer: { name: layer },
        path: pathArg,
        recipe,
        params: params.params,
        controller: extra.controller,
        source: extra.source,
        controls: plan.controls,
        replace: extra.replace,
      },
      plan: plan.controls,
    };
  };
  const go = (s: Scene, recipe: string, extra: Record<string, unknown> = {}, layer = "Box", pathArg: string[] = OPACITY) =>
    run(s, "rigRecipe", apply(s, recipe, extra, layer, pathArg).args);

  it("wiggle: creates its controls on the property's layer and links by index", () => {
    const s = recipeScene();
    const out = go(s, "wiggle");
    expect(out.expression).toBe('wiggle(effect("Wiggle Frequency")(1), effect("Wiggle Amount")(1));');
    expect(out).toMatchObject({ recipe: "wiggle", engine: "javascript-1.0", dims: "1d", controls_created: ["Wiggle Frequency", "Wiggle Amount"], controls_reused: [] });
    expect(effectsOf(s.box).map((f) => f.name)).toEqual(["Wiggle Frequency", "Wiggle Amount"]);
    expect(((effectsOf(s.box)[0] as FakeGroup).property(1) as FakeProperty).staticValue).toBe(2);
    expect(propOf(s.box, ...OPACITY).expression).toBe(out.expression);
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
    expect(evalExpr(out.expression, { "Wiggle Frequency": 3, "Wiggle Amount": 7 })).toBe("wiggle(3,7)");
  });

  it("puts the controls on a controller layer and reuses ones already there", () => {
    const s = recipeScene();
    const first = go(s, "wiggle", { controller: { name: "Controls" }, values: { frequency: 5 } });
    expect(first.expression).toContain('thisComp.layer("Controls").effect("Wiggle Frequency")(1)');
    expect(first.controller.name).toBe("Controls");
    expect(((effectsOf(s.ctl)[0] as FakeGroup).property(1) as FakeProperty).staticValue).toBe(5);
    const second = go(s, "wiggle", { controller: { name: "Controls" }, values: { frequency: 99 } }, "Box", POS);
    expect(second.controls_created).toEqual([]);
    expect(second.controls_reused).toEqual(["Wiggle Frequency", "Wiggle Amount"]);
    expect(effectsOf(s.ctl)).toHaveLength(2);
    // A reused control keeps the value it had.
    expect(((effectsOf(s.ctl)[0] as FakeGroup).property(1) as FakeProperty).staticValue).toBe(5);
    // Same name, other kind: refused.
    effectsOf(s.ctl).splice(0, effectsOf(s.ctl).length);
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Wiggle Frequency", kind: "angle" }] });
    expect(fails(s, "rigRecipe", apply(s, "wiggle", { controller: { name: "Controls" } }, "Box", ROT).args).message).toContain("not a slider control");
  });

  it("colour wiggle divides the amount, and every dimension variant is picked from the property", () => {
    const s = recipeScene();
    expect(go(s, "wiggle", {}, "Box", addColor(s.box)).expression).toContain("/ 100)");
    const flat = addSize(s.box);
    expect(go(s, "master_scale", {}, "Box", flat)).toMatchObject({ dims: "2d", expression: 'value * (effect("Master Scale")(1) / 100);' });
    expect(go(s, "master_scale", {}, "Box", SCALE)).toMatchObject({ dims: "3d", controls_reused: ["Master Scale"] });
  });

  it("refuses a property the recipe doesn't fit, naming what it fits", () => {
    const s = recipeScene();
    const fill = addColor(s.box);
    const out = fails(s, "rigRecipe", apply(s, "bounce", {}, "Box", fill).args);
    expect(out.message).toContain("doesn't fit a color property");
    expect(out.message).toContain("1d, 2d, 3d");
    expect(fails(s, "rigRecipe", apply(s, "count_up", {}, "Box", OPACITY).args).message).toContain("doesn't fit a 1d");
    expect(fails(s, "rigRecipe", apply(s, "auto_fade", {}, "Box", POS).args).message).toContain("doesn't fit a 3d");
    // Nothing was created.
    expect(effectsOf(s.box)).toHaveLength(0);
    expect(s.undo.begun).toBe(0);
  });

  it("protects an existing expression unless replace is set", () => {
    const s = recipeScene();
    propOf(s.box, ...OPACITY).expression = "time";
    expect(fails(s, "rigRecipe", apply(s, "wiggle").args).message).toContain("replace: true");
    expect(effectsOf(s.box)).toHaveLength(0);
    const out = go(s, "wiggle", { replace: true });
    expect(out.previous_expression).toBe("time");
  });

  it("takes back the controls and the old expression when setting the expression fails", () => {
    const s = recipeScene();
    propOf(s.box, ...OPACITY).expression = "time";
    sim.rejectExpr = (v) => v.startsWith("wiggle");
    expect(() => s.A.rigRecipe({ comp_id: s.comp.id, expect: GUARD, ...apply(s, "wiggle", { replace: true }).args })).toThrow("syntax");
    sim.rejectExpr = null;
    expect(effectsOf(s.box)).toHaveLength(0);
    expect(propOf(s.box, ...OPACITY).expression).toBe("time");
    expect(s.undo).toEqual({ begun: 1, ended: 1 });
  });

  it("overshoot settles to the value it overshoots around", () => {
    const s = recipeScene();
    const out = go(s, "overshoot", { controller: { name: "Controls" } });
    const controls = { "Overshoot Amplitude": 0.1, "Overshoot Frequency": 2, "Overshoot Decay": 8 };
    const env = { numKeys: 2, nearestKey: () => ({ index: 1 }), key: () => ({ time: 0.5 }), velocityAtTime: () => 100, time: 0.6, value: 50 };
    const t = 0.1;
    expect(evalExpr(out.expression, controls, env)).toBeCloseTo(50 + (100 * 0.1 * Math.sin(2 * t * 2 * Math.PI)) / Math.exp(8 * t), 6);
    // Before any key has passed, it is just the value.
    expect(evalExpr(out.expression, controls, { ...env, time: 0.2 })).toBe(50);
    expect(evalExpr(out.expression, controls, { ...env, numKeys: 0 })).toBe(50);
  });

  it("bounce: scalar and vector variants, and it comes to rest", () => {
    const s = recipeScene();
    const out = go(s, "bounce");
    expect(out.expression).toContain("var vu = (v < 0) ? -1 : 1;");
    const controls = { "Bounce Elasticity": 0.7, "Bounce Gravity": 5000, "Bounce Max Bounces": 9 };
    const env = { numKeys: 2, nearestKey: () => ({ index: 1 }), key: () => ({ time: 0.5 }), velocityAtTime: () => -200, time: 0.52, value: 50, length: Math.abs };
    const early = evalExpr(out.expression, controls, env) as number;
    expect(Number.isFinite(early)).toBe(true);
    expect(early).not.toBe(50);
    expect(evalExpr(out.expression, controls, { ...env, time: 30 })).toBe(50);
    const vec = go(s, "bounce", {}, "Box", SCALE, );
    expect(vec.expression).toContain("normalize(v)");
    expect(vec.expression).not.toContain("(v < 0)");
  });

  it("bounce: the 1D variant uses Math.abs, and no variant negates an array", () => {
    const s = recipeScene();
    const one = go(s, "bounce");
    expect(one.expression).toContain("var vl = Math.abs(v);");
    expect(one.expression).not.toContain("length(v)");
    expect(one.expression).not.toContain("= -velocityAtTime");
    const vec = go(s, "bounce", {}, "Box", SCALE);
    expect(vec.expression).toContain("var vl = length(v);");
    expect(vec.expression).toContain("velocityAtTime(key(n).time - 0.001) * -e");
  });

  it("loop: type, direction and keyframe count; warns with fewer than two keys", () => {
    const s = recipeScene();
    const out = go(s, "loop", { params: { loop_type: "pingpong", keyframes: 2 } });
    expect(out.expression).toBe('loopOut("pingpong", 2);');
    expect(out.warnings[0]).toContain("0 keyframe");
    expect(out.controls).toEqual([]);
    expect(evalExpr(out.expression, {})).toBe("loopOut(pingpong,2)");
    propOf(s.box, ...ROT).setValueAtTime(0, 0);
    propOf(s.box, ...ROT).setValueAtTime(1, 90);
    const back = go(s, "loop", { params: { direction: "in" } }, "Box", ROT);
    expect(back.expression).toBe('loopIn("cycle", 0);');
    expect(back.warnings).toEqual([]);
  });

  it("follow_delay reads the same property of the source by match names", () => {
    const s = recipeScene();
    const out = go(s, "follow_delay", { source: { name: "Controls" } }, "Box", POS);
    expect(out.expression).toContain('var src = thisComp.layer("Controls")("ADBE Transform Group")("ADBE Position");');
    expect(evalExpr(out.expression, { "Follow Delay": 0.25 })).toBe("ADBE Transform Group/ADBE Position@0.75");
    expect(fails(s, "rigRecipe", { ...apply(s, "follow_delay", {}, "Box", ROT).args, replace: true }).message).toContain("source layer");
    const dup = s.comp.layers.addNull(4) as FakeLayer;
    dup.name = "Controls";
    expect(fails(s, "rigRecipe", { ...apply(s, "follow_delay", { source: { index: s.ctl.index } }, "Box", ROT).args, replace: true }).message).toContain("tell them apart");
  });

  it("auto_fade fades between the layer's in and out points", () => {
    const s = recipeScene();
    const out = go(s, "auto_fade");
    const controls = { "Fade In": 1, "Fade Out": 1 };
    expect(evalExpr(out.expression, controls, { time: 0, value: 80 })).toBe(0);
    expect(evalExpr(out.expression, controls, { time: 0.5, value: 80 })).toBe(40);
    expect(evalExpr(out.expression, controls, { time: 2, value: 80 })).toBe(80);
    expect(evalExpr(out.expression, controls, { time: 3.5, value: 80 })).toBe(40);
    expect(evalExpr(out.expression, { "Fade In": 0, "Fade Out": 0 }, { time: 2, value: 80 })).toBe(80);
    expect(out.warnings).toEqual([]);
    expect(go(s, "auto_fade", { name_prefix: "Fade2" }, "Box", ROT).warnings[0]).toContain("meant for Opacity");
  });

  it("count_up formats with separators, decimals, a prefix and a suffix", () => {
    const s = recipeScene();
    const textPath = ["ADBE Text Properties", "ADBE Text Document"];
    const out = go(s, "count_up", { params: { prefix: "$", suffix: ' "pts"', separator: "," } }, "Hello", textPath);
    expect(out).toMatchObject({ dims: "text" });
    const controls = { "Count Start": 0, "Count End": 1234567.891, "Count Duration": 2, "Count Decimals": 2 };
    expect(evalExpr(out.expression, controls, { time: 2 })).toBe('$1,234,567.89 "pts"');
    expect(evalExpr(out.expression, controls, { time: 99 })).toBe('$1,234,567.89 "pts"');
    expect(evalExpr(out.expression, controls, { time: 0 })).toBe('$0.00 "pts"');
    expect(evalExpr(out.expression, { ...controls, "Count Start": 0, "Count End": -2500, "Count Decimals": 0 }, { time: 2 })).toBe('$-2,500 "pts"');
    const plain = go(s, "count_up", { name_prefix: "N", replace: true, params: { separator: "", easing: "ease" } }, "Hello", textPath, );
    expect(plain.expression).toContain("ease(k, 0, 1, 0, 1)");
    // A Decimals slider past 20 is clamped, so toFixed never throws.
    expect(evalExpr(out.expression, { ...controls, "Count Decimals": 99 }, { time: 2 })).toBe(evalExpr(out.expression, { ...controls, "Count Decimals": 20 }, { time: 2 }));
    expect(out.expression).toContain("Math.min(20,");
    expect(evalExpr(plain.expression, { "N Start": 0, "N End": 12345, "N Duration": 2, "N Decimals": 0 }, { time: 2 })).toBe("12345");
  });

  it("master_scale, tint_color and ease_between", () => {
    const s = recipeScene();
    expect(evalExpr(go(s, "master_scale").expression, { "Master Scale": 150 }, { value: 40 })).toBe(60);
    const tint = go(s, "tint_color", {}, "Box", addColor(s.box));
    expect(tint.expression).toBe('linear(effect("Tint Amount")(1), 0, 100, value, effect("Tint Color")(1));');
    expect(evalExpr(tint.expression, { "Tint Amount": 100, "Tint Color": 7 }, { value: 1 })).toBe(7);
    const ease = go(s, "ease_between", { params: { from: 10, to: 110 } }, "Box", ROT);
    expect(ease.expression).toBe('ease(effect("Ease Progress")(1), 0, 100, 10, 110);');
    expect(evalExpr(ease.expression, { "Ease Progress": 0 })).toBe(10);
    expect(evalExpr(ease.expression, { "Ease Progress": 50 })).toBe(60);
    expect(evalExpr(ease.expression, { "Ease Progress": 100 })).toBe(110);
    const pos = go(s, "ease_between", { params: { from: [0, 0, 0], to: [100, 50, 0] }, name_prefix: "Move" }, "Box", POS);
    expect(pos.expression).toBe('ease(effect("Move Progress")(1), 0, 100, [0, 0, 0], [100, 50, 0]);');
  });

  it("ease_between needs from and to to match the property's dimensions", () => {
    const s = recipeScene();
    const base = apply(s, "ease_between", { params: { from: 0, to: 1 } }, "Box", POS).args;
    expect(fails(s, "rigRecipe", base).message).toContain("list of 3 numbers");
    const flat = apply(s, "ease_between", { params: { from: [0, 0], to: [1, 1] } }, "Box", ROT).args;
    expect(fails(s, "rigRecipe", flat).message).toContain("single number");
    expect(effectsOf(s.box)).toHaveLength(0);
  });

  it("follow_text sizes to a text layer's box and follow_text_position sits at its centre", () => {
    const s = recipeScene();
    const flat = addSize(s.box);
    const size = go(s, "follow_text", { source: { name: "Hello" } }, "Box", flat);
    const text = {
      sourceRectAtTime: () => ({ left: -50, top: -20, width: 100, height: 40 }),
      toComp: (p: number[]) => [p[0] + 300, p[1] + 200],
    };
    const env = { thisComp: { layer: () => Object.assign(() => undefined, { effect: (n: string) => (i: number) => i && n, ...text }) } };
    expect(evalExpr(size.expression, { "Text Box Padding": 10 }, { ...env, thisComp: { layer: () => text } })).toEqual([120, 60]);
    const pos = go(s, "follow_text_position", { source: { name: "Hello" } }, "Box", POS);
    expect(pos.controls).toEqual([]);
    expect(evalExpr(pos.expression, {}, { thisComp: { layer: () => text }, value: [0, 0, 77] })).toEqual([300, 200, 77]);
    // On a parented layer the comp-space point goes into the parent's space.
    expect(
      evalExpr(pos.expression, {}, { thisComp: { layer: () => text }, value: [0, 0, 77], hasParent: true, parent: { fromComp: (p: number[]) => [p[0] - 10, p[1] - 20] } })
    ).toEqual([290, 180, 77]);
    const flat2 = addSize(s.ctl);
    expect(go(s, "follow_text_position", { source: { name: "Hello" } }, "Controls", flat2).expression).toContain("[p[0], p[1]];");
  });

  it("every recipe builds for each dimension it lists, and only those", () => {
    const dimProp = (s: Scene, dims: string, layer: FakeLayer) => {
      if (dims === "1d") return OPACITY;
      if (dims === "3d") return POS;
      if (dims === "2d") return addSize(layer);
      if (dims === "color") return addColor(layer);
      return ["ADBE Text Properties", "ADBE Text Document"];
    };
    for (const r of RECIPES) {
      for (const dims of ["1d", "2d", "3d", "color", "text"] as const) {
        const s = recipeScene();
        const layer = dims === "text" ? s.text : s.box;
        const extra: Record<string, unknown> = {};
        if (r.needs_source) extra.source = { name: "Controls" };
        if (r.name === "ease_between") extra.params = { from: dims === "1d" ? 0 : dims === "3d" ? [0, 0, 0] : [0, 0], to: dims === "1d" ? 1 : dims === "3d" ? [1, 1, 1] : [1, 1] };
        const path = dimProp(s, dims, layer);
        const info = apply(s, r.name, extra, layer.name, path);
        const listed = r.dims.includes(dims);
        if (listed) {
          const out = run(s, "rigRecipe", info.args);
          expect(out.dims, `${r.name} ${dims}`).toBe(dims);
          expect(out.expression.length).toBeGreaterThan(5);
          expect(propOf(layer, ...path).expression).toBe(out.expression);
          // The generated text parses as an expression.
          expect(() => new vm.Script(out.expression), `${r.name} ${dims}`).not.toThrow();
        } else {
          expect(fails(s, "rigRecipe", info.args).message, `${r.name} ${dims}`).toContain("doesn't fit");
        }
      }
    }
  });

  it("the host knows exactly the recipes the catalogue lists", () => {
    const s = recipeScene();
    expect(fails(s, "rigRecipe", { layer: { name: "Box" }, path: OPACITY, recipe: "nonsense", controls: [] }).message).toContain("Unknown recipe");
    for (const r of RECIPES) {
      const msg = (() => {
        try {
          s.A.rigRecipe({ comp_id: s.comp.id, expect: GUARD, layer: { name: "Box" }, path: OPACITY, recipe: r.name, controls: [] });
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect(msg, r.name).not.toContain("Unknown recipe");
    }
  });

  it("a recipe whose control is missing from the call says which", () => {
    const s = recipeScene();
    expect(fails(s, "rigRecipe", { layer: { name: "Box" }, path: OPACITY, recipe: "wiggle", controls: [] }).message).toContain('needs a control "amount"');
  });

  it("flags unsafe names: a layer with a quote can't hold shared controls", () => {
    const s = recipeScene();
    s.ctl.name = 'Co"ntrols';
    const args = apply(s, "wiggle", { controller: { index: s.ctl.index } }).args;
    expect(fails(s, "rigRecipe", args).message).toContain("quote");
    expect(PropertyType.PROPERTY).toBeDefined();
  });
});

describe("rig.jsx and rig.ts: review fixes", () => {
  it("a layer control keeps pointing at the layer asked for when a null is added above it", () => {
    const s = scene();
    const out = run(s, "rigAddControls", {
      layer: { name: "Rig" },
      create_if_missing: true,
      controls: [{ name: "Target", kind: "layer", layer: { index: s.box.index } }],
    });
    expect(out.created_layer).toBe(true);
    expect(out.controls[0].target_layer_id).toBe(s.box.id);
    const rig = s.comp.layer("Rig") as FakeLayer;
    const value = (effectsOf(rig)[0] as FakeGroup).property(1) as FakeProperty;
    expect(value.staticValue).toBe(s.box.index);
    const state = run(s, "rigState", { controls: [{ layer: { name: "Rig" }, name: "Target" }] });
    expect(state.controls[0].layer_target).toMatchObject({ id: s.box.id, name: "Box" });
    const spec = { name: "Target", kind: "layer", layer: { index: 2 } } as ControlSpec;
    const m: Parameters<typeof controlMismatches>[0] = [];
    controlMismatches(m, "c", spec, state.controls[0], true, s.box.id);
    expect(m).toEqual([]);
    controlMismatches(m, "c", spec, state.controls[0], true, s.ctl.id);
    expect(m[0].path).toBe("c.layer");
  });

  it("limits sliders to +-1,000,000 before AE is touched, and angles are wider", () => {
    const s = scene();
    expect(controlSpecProblem({ name: "S", kind: "slider", value: 5e6 })).toContain("within");
    expect(controlSpecProblem({ name: "S", kind: "slider", value: 1e6 })).toBeNull();
    expect(controlSpecProblem({ name: "A", kind: "angle", value: 5e6 })).toBeNull();
    expect(fails(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "S", kind: "slider", value: 5e6 }] })).toMatchObject({ kind: "bad_args" });
    expect(s.undo.begun).toBe(0);
  });

  it("reads back a dropdown of 100 items whole", () => {
    const s = scene();
    const items = Array.from({ length: 100 }, (_, i) => `Item ${i + 1}`);
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Mode", kind: "dropdown", items, value: 1 }] });
    const state = run(s, "rigState", { controls: [{ layer: { name: "Controls" }, name: "Mode" }] });
    expect(state.controls[0].items).toEqual(items);
    const m: Parameters<typeof controlMismatches>[0] = [];
    controlMismatches(m, "c", { name: "Mode", kind: "dropdown", items, value: 1 } as ControlSpec, state.controls[0]);
    expect(m).toEqual([]);
    // A host read that was cut short compares only the items it read.
    controlMismatches(m, "c", { name: "Mode", kind: "dropdown", items } as ControlSpec, { ...state.controls[0], items: items.slice(0, 40), items_truncated: true });
    expect(m).toEqual([]);
  });

  it("a capped reference scan is not a mismatch, and a comp over 500 layers sets it", () => {
    const s = scene();
    for (let i = 0; i < 500; i++) s.comp.layers.addNull(4);
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }] });
    const state = run(s, "rigState", { scans: [{ layer: { name: "Controls" }, name: "Speed" }] });
    expect(state.scan_truncated).toBe(true);
    const args = { comp_id: 1, layer: { name: "Controls" }, control: "Speed", new_name: "Gain", expect: expectArg } as never;
    const after = { props: [], controls: [{ found: true, name: "Gain", kind: "slider" }], scans: [{ found: true, name: "Speed", count: 0, references: [], truncated: false }], scan_truncated: true };
    expect(renameMismatches(args, undefined, after)).toEqual([]);
    const list = run(s, "rigList", {});
    expect(list.scan_truncated).toBe(true);
    expect(list.warning).toContain("capped");
    // The rename still asks autoFixExpressions when the scan was capped.
    const out = run(s, "rigRename", { layer: { name: "Controls" }, control: "Speed", new_name: "Gain" });
    expect(out.scan_truncated).toBe(true);
    expect(out.autofix).toBe("attempted");
  });

  it("skips a past-the-cap new-error report when the before scan was capped", () => {
    const args = { comp_id: 1, layer: { name: "Controls" }, control: "Speed", new_name: "Gain", expect: expectArg } as never;
    const ref = (n: number, error: string | null) => ({ layer_id: n, layer_name: `L${n}`, path: "p", match_path: ["m"], expression: "x", error });
    const before = { props: [], controls: [{ found: true, name: "Speed", kind: "slider" }], scans: [{ found: true, name: "Speed", count: 60, references: [ref(1, null)], truncated: true }] };
    const after = { props: [], controls: [{ found: true, name: "Gain", kind: "slider" }], scans: [{ found: true, name: "Speed", count: 0, references: [], truncated: false }, { found: true, name: "Gain", count: 60, references: [ref(1, null), ref(2, "old error")], truncated: true }] };
    expect(renameMismatches(args, before, after)).toEqual([]);
  });

  it("does not count another layer's control of the same name as a reference", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Box" }, controls: [{ name: "Speed", kind: "slider" }] });
    propOf(s.box, ...OPACITY).expression = 'thisComp.layer("Controls").effect("Speed")(1)';
    propOf(s.box, ...ROT).expression = 'effect("Speed")(1)';
    const scan = (layer: string) => run(s, "rigState", { scans: [{ layer: { name: layer }, name: "Speed" }] }).scans[0];
    // Box's own Speed: only the unprefixed one. Controls has no Speed control, but the text still names its layer.
    expect(scan("Box").count).toBe(1);
    expect(scan("Controls").count).toBe(1);
  });

  it("an unprefixed effect() next to the holder's layer name is the layer's own control", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Box" }, controls: [{ name: "Speed", kind: "slider" }] });
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Gain", kind: "slider" }] });
    propOf(s.box, ...OPACITY).expression = 'effect("Speed")(1) + thisComp.layer("Controls").effect("Gain")(1)';
    const scan = (layer: string, name: string) => run(s, "rigState", { scans: [{ layer: { name: layer }, name }] }).scans[0];
    // Renaming Controls' Speed must not count Box's own effect("Speed").
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }] });
    expect(scan("Controls", "Speed").count).toBe(0);
    expect(scan("Box", "Speed").count).toBe(1);
    expect(scan("Controls", "Gain").count).toBe(1);
    // Through a variable it still reaches the holder.
    propOf(s.box, ...ROT).expression = 'var c = thisComp.layer("Controls"); c.effect("Speed")(1)';
    expect(scan("Controls", "Speed").count).toBe(1);
    propOf(s.box, ...ROT).expression = 'thisLayer.effect("Speed")(1) + thisComp.layer("Controls").index';
    expect(scan("Controls", "Speed").count).toBe(0);
  });

  it("link, unlink and recipe refuse a locked layer or separated Position before the undo group", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }] });
    s.undo.begun = 0;
    s.undo.ended = 0;
    const target = { layer: { name: "Box" }, path: OPACITY };
    const linkArgs = { links: [{ ...target, control: { layer: { name: "Controls" }, name: "Speed" } }] };
    // A locked layer with no expression is a no-op for unlink: skipped, not refused.
    (s.box as { locked: boolean }).locked = true;
    const noop = run(s, "rigUnlink", { targets: [target] }) as { skipped: Array<{ reason?: string }>; unlinked: unknown[] };
    expect(noop.skipped).toHaveLength(1);
    expect(noop.skipped[0].reason).toContain("no expression");
    expect(noop.unlinked).toHaveLength(0);
    (s.box as { locked: boolean }).locked = false;
    propOf(s.box, ...OPACITY).expression = 'thisLayer.effect("Speed")(1)';
    s.undo.begun = 0;
    s.undo.ended = 0;
    (s.box as { locked: boolean }).locked = true;
    expect(fails(s, "rigLink", linkArgs).message).toContain("locked");
    expect(fails(s, "rigUnlink", { targets: [target] }).message).toContain("locked");
    expect(fails(s, "rigRecipe", { recipe: "wiggle", layer: { name: "Box" }, path: OPACITY }).message).toContain("locked");
    expect(fails(s, "rigAddControls", { layer: { name: "Box" }, controls: [{ name: "Z", kind: "slider" }] }).message).toContain("locked");
    (s.box as { locked: boolean }).locked = false;
    // A locked controller: refused only when the recipe has a control to create.
    const ctlLayer = s.ctl as unknown as { locked: boolean };
    ctlLayer.locked = true;
    const rArgs = (controls: unknown[]) => ({
      recipe: "wiggle", layer: { name: "Box" }, controller: { name: "Controls" }, path: OPACITY, replace: true, controls,
    });
    const both = [{ key: "frequency", name: "Speed", kind: "slider" }, { key: "amount", name: "Amt", kind: "slider" }];
    expect(fails(s, "rigRecipe", rArgs(both)).message).toContain("locked");
    expect(fails(s, "rigRename", { layer: { name: "Controls" }, control: "Speed", new_name: "Gain" }).message).toContain("locked");
    expect(s.undo).toEqual({ begun: 0, ended: 0 });
    ctlLayer.locked = false;
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Amt", kind: "slider" }] });
    s.undo.begun = 0;
    s.undo.ended = 0;
    ctlLayer.locked = true;
    expect(() => run(s, "rigRecipe", rArgs(both))).not.toThrow();
    ctlLayer.locked = false;
    s.undo.begun = 0;
    s.undo.ended = 0;
    (propOf(s.box, ...POS) as unknown as { dimensionsSeparated: boolean }).dimensionsSeparated = true;
    const posLink = { links: [{ layer: { name: "Box" }, path: POS, control: { layer: { name: "Controls" }, name: "Speed" } }] };
    expect(fails(s, "rigLink", posLink).message).toContain("separated");
    (propOf(s.box, ...POS) as unknown as { expression: string }).expression = "[0, 0]";
    expect(fails(s, "rigUnlink", { targets: [{ layer: { name: "Box" }, path: POS }] }).message).toContain("separated");
    expect(fails(s, "rigRecipe", { recipe: "wiggle", layer: { name: "Box" }, path: POS }).message).toContain("separated");
    expect(s.undo).toEqual({ begun: 0, ended: 0 });
  });

  it("lists at most 500 references in total and says so", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Speed", kind: "slider" }, { name: "Gain", kind: "slider" }] });
    for (let i = 0; i < 30; i++) {
      const l = s.comp.layers.addNull(4) as FakeLayer;
      armLayer(l);
      propOf(l, ...OPACITY).expression = 'thisComp.layer("Controls").effect("Speed")(1)';
      propOf(l, ...ROT).expression = 'thisComp.layer("Controls").effect("Gain")(1)';
    }
    const out = run(s, "rigList", { layer: { name: "Controls" } });
    const total = out.controls.reduce((n: number, c: { references: unknown[] }) => n + c.references.length, 0);
    expect(total).toBe(60);
    expect(out.references_truncated).toBe(false);
    expect(out.controls[0].references_count).toBe(30);
  });

  it("names a dropdown again after its items are set", () => {
    const s = scene();
    run(s, "rigAddControls", { layer: { name: "Controls" }, controls: [{ name: "Mode", kind: "dropdown", items: ["A", "B"] }] });
    expect(effectsOf(s.ctl).map((f) => f.name)).toEqual(["Mode"]);
  });
});
