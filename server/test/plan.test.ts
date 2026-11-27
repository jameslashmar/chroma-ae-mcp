/**
 * ae_plan: read before a task. Questions follow the user's "Ask first" choice in the panel (off by
 * default): off, no question and the defaults as assumptions; on, questions with options from the
 * project, which answers then close.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import { AePlanSchema, buildPlan, guessIntent, PLAN_INTENTS, PLAN_TOOLS, planTools, resolveLayers, type PlanContext, type PlanLayer } from "../src/tools/ext/plan.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { META_TOOL_NAMES } from "../src/toolsets.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function settings(askFirst?: boolean): SettingsStore {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-plan-"));
  dirs.push(d);
  const s = new SettingsStore(path.join(d, "settings.json"));
  if (askFirst !== undefined) s.updatePlan({ ask_first: askFirst });
  return s;
}

const layer = (index: number, name: string, kind: string, extra: Partial<PlanLayer> = {}): PlanLayer => ({ index, id: 100 + index, name, kind, three_d: false, enabled: true, locked: false, selected: false, keyed: [], effects: 0, ...extra });

function project(o: { comp?: boolean; layers?: PlanLayer[]; unsaved?: boolean; dirty?: boolean; hazard?: boolean; workArea?: [number, number] } = {}): PlanContext {
  const layers = o.layers ?? [layer(1, "Logo", "footage"), layer(2, "Title", "text"), layer(3, "BG", "solid")];
  return {
    project_path: o.unsaved ? "<unsaved>" : "D:/jobs/spot.aep",
    dirty: o.dirty ?? false,
    ae_version: "26.3x87",
    comps: [
      { id: 7, name: "Main", width: 1920, height: 1080, fps: 25, duration: 10, num_layers: 3, active: o.comp !== false },
      { id: 8, name: "Endcard", width: 1920, height: 1080, fps: 25, duration: 4, num_layers: 2, active: false },
    ],
    comps_total: 2,
    comp:
      o.comp === false
        ? null
        : {
            id: 7,
            name: "Main",
            why: "active",
            width: 1920,
            height: 1080,
            fps: 25,
            duration: 10,
            work_area: o.workArea ?? [0, 10],
            time: 0,
            renderer: "ADBE Advanced 3d",
            layers,
            layers_total: layers.length,
            selected_layers: layers.filter((l) => l.selected).map((l) => l.index),
            selected_properties: [],
            render_hazard: o.hazard ? { comp_id: 7, comp_name: "Main", light: "Env", layer: "Card" } : null,
          },
    comp_not_found: false,
    render_queue: { items: 0, queued: 0 },
  };
}

describe("buildPlan", () => {
  it("names only real tools, for every kind of task", () => {
    for (const intent of PLAN_INTENTS) buildPlan({ request: "x", intent }, project({ unsaved: true }), true);
    buildPlan({ request: "x", intent: "edit" }, project({ dirty: true }), false);
    const known = new Set<string>([...ALL_TOOLS.map((t) => t.name), ...META_TOOL_NAMES]);
    const unknown = [...PLAN_TOOLS].filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
    expect(PLAN_TOOLS.size).toBeGreaterThan(30);
  });

  it("Ask first off (the default): no question, the defaults are the assumptions, and the agent is told to go ahead", () => {
    const p: any = buildPlan({ request: "make the logo bounce in", intent: "animate" }, project(), false);
    expect(p.ask_first).toBe(false);
    expect(p.questions).toEqual([]);
    expect(p.assumptions.map((a: any) => a.id)).toEqual(["layer", "duration", "feel"]);
    expect(p.assumptions.find((a: any) => a.id === "duration")).toMatchObject({ assumed: "1 s", value: "1" });
    expect(p.next).toMatch(/Ask first is off.*ask nothing.*tell the user the assumptions/);
    expect(p.plan.map((s: any) => s.tool)).toEqual(["ae_get_layer_props", "ae_set_property", "ae_set_keyframe_ease", "ae_motion_review"]);
  });

  it("Ask first on: questions with options from the project, and the answers close them", () => {
    const p: any = buildPlan({ request: "make it bounce in", intent: "animate" }, project(), true);
    expect(p.assumptions).toEqual([]);
    const lq = p.questions.find((q: any) => q.id === "layer");
    expect(lq.options.map((o: any) => o.label)).toEqual(["Logo", "Title", "BG"]);
    expect(p.questions.find((q: any) => q.id === "duration").options[1]).toMatchObject({ value: "1", detail: "25 frames at 25 fps" });
    expect(p.questions.find((q: any) => q.id === "feel").kind).toBe("ease");
    expect(p.next).toMatch(/one at a time.*ae_ask_user.*call ae_plan again with answers/);
    const again: any = buildPlan({ request: "make it bounce in", intent: "animate", answers: { layer: "1", duration: "2", feel: "snappy" } }, project(), true);
    expect(again.questions).toEqual([]);
    expect(again.answered).toEqual({ layer: "1", duration: "2", feel: "snappy" });
    expect(again.next).toMatch(/Nothing left to ask/);
  });

  it("resolves the named and the selected layers, and asks about keys already on them", () => {
    const layers = [layer(1, "Logo", "footage", { keyed: ["position"] }), layer(2, "Title", "text", { selected: true }), layer(3, "BG", "solid")];
    const p: any = buildPlan({ request: "move the logo", intent: "animate", layers: ["logo", "Ghost"] }, project({ layers }), true);
    expect(p.understood.layers).toEqual([{ index: 1, name: "Logo", kind: "footage", keyed: ["position"] }]);
    expect(p.understood.layers_from).toBe("named");
    expect(p.notes.join(" ")).toMatch(/No layer named "Ghost"/);
    expect(p.questions.find((q: any) => q.id === "existing_keys")).toMatchObject({ default: "keep" });
    expect(p.questions.some((q: any) => q.id === "layer")).toBe(false);
    expect(resolveLayers(project({ layers }), undefined)).toMatchObject({ from: "selected", layers: [{ name: "Title" }] });
  });

  it("asks which comp when none is open, offers saving or a checkpoint, and states the render hazard", () => {
    const p: any = buildPlan({ request: "render the endcard", intent: "render" }, project({ comp: false, unsaved: true }), true);
    expect(p.questions[0]).toMatchObject({ id: "comp", default: "8" });
    expect(p.questions[0].options.map((o: any) => o.label)).toEqual(["Endcard"]);
    expect(p.extras[0]).toMatchObject({ tool: "ae_save", run: "ask" });
    const dirty: any = buildPlan({ request: "x", intent: "edit" }, project({ dirty: true }), false);
    expect(dirty.plan[0]).toMatchObject({ tool: "ae_checkpoint_create" });
    const hz: any = buildPlan({ request: "x", intent: "compose_3d" }, project({ hazard: true }), false);
    expect(hz.hazards[0]).toMatch(/never finishes rendering "Main".*"Env" takes its image from a layer/);
    const wa: any = buildPlan({ request: "render it", intent: "render" }, project({ workArea: [2, 3] }), true);
    expect(wa.questions.find((q: any) => q.id === "range")).toMatchObject({ default: "whole" });
  });

  it("guesses the intent from English words when none is given", () => {
    expect(guessIntent("Export an MP4 for the client")).toBe("render");
    expect(guessIntent("pin the phone screen")).toBe("track");
    expect(guessIntent("fade the title in")).toBe("text");
    expect(guessIntent("do something nice")).toBe("other");
    const p: any = buildPlan({ request: "fade the logo in" }, project(), false);
    expect(p.understood).toMatchObject({ intent: "animate", intent_from: "guessed" });
  });
});

describe("ae_plan tool", () => {
  it("is off by default, follows the setting, and re-reads the comp a question answered", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mk = (s: SettingsStore) =>
      ({ settings: s, bridge: { callHost: async (_fn: string, args: Record<string, unknown>) => (calls.push(args), { result: project() }) } }) as unknown as ToolContext;
    const tool = planTools.find((t) => t.name === "ae_plan")!;
    const off: any = await tool.handler(AePlanSchema.parse({ request: "make the logo bounce", intent: "animate" }), mk(settings()));
    expect(off.ask_first).toBe(false);
    expect(off.questions).toEqual([]);
    const on: any = await tool.handler(AePlanSchema.parse({ request: "make the logo bounce", intent: "animate" }), mk(settings(true)));
    expect(on.questions.length).toBeGreaterThan(0);
    await tool.handler(AePlanSchema.parse({ request: "x", answers: { comp: "8" } }), mk(settings(true)));
    expect(calls[calls.length - 1]).toEqual({ comp_id: 8 });
  });

  it("the setting is off by default and survives a restart", () => {
    const s = settings();
    expect(s.get().plan.ask_first).toBe(false);
    s.updatePlan({ ask_first: true });
    expect(new SettingsStore(s.path).get().plan.ask_first).toBe(true);
  });
});

describe("plan.jsx planContext", () => {
  it("reads the comps, the active comp's layers, their kinds, selection and keys, and the render queue", () => {
    const proj = new FakeProject();
    const comp = proj.addComp("Main", 1920, 1080, 10);
    proj.addComp("Endcard", 1920, 1080, 4);
    const bg = comp.layers.addSolid([0, 0, 0], "BG", 1920, 1080, 1) as any;
    const title = comp.layers.addText("Title") as any;
    title.selected = true;
    bg.transform("Position").setValueAtTime(0, [0, 0, 0]);
    bg.transform("Position").setValueAtTime(1, [100, 0, 0]);
    (proj as any).activeItem = comp;
    const { A } = loadHost(proj, ["plan.jsx"]);
    const r = A.planContext({});
    expect(r).toMatchObject({ project_path: "<unsaved>", comps_total: 2, comp: { id: comp.id, name: "Main", why: "active", layers_total: 2 } });
    const byName = Object.fromEntries(r.comp.layers.map((l: any) => [l.name, l]));
    expect(byName.Title).toMatchObject({ kind: "text", selected: true });
    expect(byName.BG.keyed).toEqual(["position"]);
    expect(r.comp.selected_layers).toEqual([byName.Title.index]);
    expect(A.planContext({ comp_id: 999 })).toMatchObject({ comp: null, comp_not_found: true });
  });
});
