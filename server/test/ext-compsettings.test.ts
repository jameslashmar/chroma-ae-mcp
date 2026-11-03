import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeCompSettingsSchema,
  AeGetCompSettingsSchema,
  compareToBrief,
  compSettingsMismatches,
  compsettingsTools,
  simulateGuides,
  type CompSettingsInfo,
} from "../src/tools/ext/compsettings.js";
import { FakeProject, GUARD, loadHost, type FakeComp } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => compsettingsTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-compsettings-q-"));
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
      if (next instanceof Error) throw next;
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const info = (extra: Partial<CompSettingsInfo> = {}): CompSettingsInfo => ({
  comp_id: 1,
  name: "Main",
  width: 1920,
  height: 1080,
  fps: 25,
  frame_duration: 0.04,
  duration: 10,
  motion_blur: false,
  shutter_angle: 180,
  shutter_phase: -90,
  motion_blur_samples: 16,
  motion_blur_adaptive_limit: 128,
  frame_blending: false,
  draft_3d: false,
  hide_shy_layers: false,
  preserve_nested_frame_rate: false,
  preserve_nested_resolution: false,
  display_start_time: 0,
  display_start_frame: 0,
  renderer: "ADBE Advanced 3d",
  renderers: ["ADBE Advanced 3d", "ADBE Calder"],
  resolution_factor: [1, 1],
  background_color: [0, 0, 0],
  work_area: { start: 0, duration: 10 },
  guides: [],
  guide_count: 0,
  ...extra,
});

describe("schemas", () => {
  it("accept a typical write and reject out-of-range or unknown values", () => {
    const ok = AeCompSettingsSchema.safeParse({ comp_id: 1, settings: { motion_blur: true, shutter_angle: 180 }, expect: expectArg });
    expect(ok.success).toBe(true);
    for (const settings of [
      { shutter_angle: 721 },
      { shutter_angle: 90.5 },
      { shutter_phase: -361 },
      { motion_blur_samples: 1 },
      { motion_blur_adaptive_limit: 257 },
      { resolution_factor: [0, 1] },
      { resolution_factor: [1, 100] },
      { background_color: [0, 0, 2] },
      { work_area: {} },
      { work_area: { start: 2, end: 6 } },
      { work_area: { duration: 0 } },
      { display_start_time: 90000 },
      { display_start_time: 1, display_start_frame: 25 },
      { motionBlur: true },
    ]) {
      expect(AeCompSettingsSchema.safeParse({ comp_id: 1, settings, expect: expectArg }).success, JSON.stringify(settings)).toBe(false);
    }
  });

  it("needs something to change and checks guide operations", () => {
    expect(AeCompSettingsSchema.safeParse({ comp_id: 1, expect: expectArg }).success).toBe(false);
    expect(AeCompSettingsSchema.safeParse({ comp_id: 1, settings: {}, guides: [], expect: expectArg }).success).toBe(false);
    const g = (guides: unknown[]) => AeCompSettingsSchema.safeParse({ comp_id: 1, guides, expect: expectArg }).success;
    expect(g([{ action: "add", orientation: "vertical", position: 960 }])).toBe(true);
    expect(g([{ action: "add", position: 960 }])).toBe(false);
    expect(g([{ action: "set", index: 0, position: 10 }])).toBe(true);
    expect(g([{ action: "set", index: 0, orientation: "vertical", position: 10 }])).toBe(false);
    expect(g([{ action: "remove", index: 1 }])).toBe(true);
    expect(g([{ action: "remove" }])).toBe(false);
    expect(g([{ action: "add", orientation: "vertical", position: 10, position_type: "percent" }])).toBe(false);
    expect(g([{ action: "add", orientation: "horizontal", position: 200000 }])).toBe(false);
  });

  it("requires expect on the write and not on the read", () => {
    expect(AeCompSettingsSchema.safeParse({ comp_id: 1, settings: { motion_blur: true } }).success).toBe(false);
    expect(AeGetCompSettingsSchema.safeParse({ comp_id: 1 }).success).toBe(true);
    expect(tool("ae_comp_settings").description).toContain("target guard failure");
  });
});

describe("compareToBrief", () => {
  it("lists the fields that differ, with a frame of slack on the length", () => {
    const i = info();
    expect(compareToBrief(i, { width: 1920, height: 1080, fps: 25, duration_s: 10.02, motion_blur: false })).toEqual([]);
    const d = compareToBrief(i, { width: 1280, fps: 30, duration_s: 12, motion_blur: true });
    expect(d.map((x) => x.field)).toEqual(["width", "fps", "duration_s", "motion_blur"]);
  });
});

describe("simulateGuides", () => {
  it("adds at the end, moves in place and shifts after a remove", () => {
    const list = simulateGuides(
      [
        { orientation_type: 0, position: 10 },
        { orientation_type: 1, position: 20 },
      ],
      [
        { action: "add", orientation_type: 1, position: 30 },
        { action: "remove", index: 0 },
        { action: "set", index: 0, position: 25 },
      ]
    );
    expect(list).toEqual([
      { orientation_type: 1, position: 25 },
      { orientation_type: 1, position: 30, added: true },
    ]);
  });
});

describe("compSettingsMismatches", () => {
  const parse = (v: object) => AeCompSettingsSchema.parse({ comp_id: 1, expect: expectArg, ...v });

  it("accepts a write that reads back and flags a value AE clamped", () => {
    const args = parse({ settings: { motion_blur: true, shutter_angle: 270, renderer: "ADBE Calder" } });
    const before = info();
    const good = info({ motion_blur: true, shutter_angle: 270, renderer: "ADBE Calder" });
    expect(compSettingsMismatches(args, before, good, {})).toEqual([]);
    const clamped = info({ motion_blur: true, shutter_angle: 180, renderer: "ADBE Calder" });
    expect(compSettingsMismatches(args, before, clamped, {}).map((m) => m.path)).toEqual(["settings.shutter_angle"]);
  });

  it("flags a setting that changed without being asked, and an unreadable one", () => {
    const args = parse({ settings: { frame_blending: true } });
    const after = info({ frame_blending: true, motion_blur: true });
    expect(compSettingsMismatches(args, info(), after, {}).map((m) => m.path)).toEqual(["settings.motion_blur"]);
    const blind = info();
    delete blind.frame_blending;
    expect(compSettingsMismatches(args, info(), blind, {})[0].message).toMatch(/could not be read back/);
  });

  it("checks the work area against what the host wrote, within a frame", () => {
    const args = parse({ settings: { work_area: { start: 2 } } });
    const written = { work_area: { start: 2, duration: 8 } };
    expect(compSettingsMismatches(args, info(), info({ work_area: { start: 2.02, duration: 7.98 } }), written)).toEqual([]);
    expect(compSettingsMismatches(args, info(), info({ work_area: { start: 0, duration: 8 } }), written).map((m) => m.path)).toEqual(["settings.work_area.start"]);
  });

  it("checks guides against the simulated list", () => {
    const args = parse({ guides: [{ action: "add", orientation: "vertical", position: 960 }] });
    const written = { guides_applied: [{ action: "add", orientation_type: 1, position: 960 }] };
    const after = info({ guide_count: 1, guides: [{ index: 0, orientation_type: 1, position: 960 }] });
    expect(compSettingsMismatches(args, info(), after, written)).toEqual([]);
    const wrong = info({ guide_count: 1, guides: [{ index: 0, orientation_type: 0, position: 900 }] });
    expect(compSettingsMismatches(args, info(), wrong, written).map((m) => m.path)).toEqual(["guides[0].position", "guides[0].orientation_type"]);
    expect(compSettingsMismatches(args, info(), info(), written).map((m) => m.path)).toEqual(["guides.length"]);
  });
});

describe("tool handlers", () => {
  it("ae_get_comp_settings reads once and reports brief differences", async () => {
    const { ctx, calls } = fakeAe({ compsettingsRead: [info()] });
    const out = (await tool("ae_get_comp_settings").handler(AeGetCompSettingsSchema.parse({ comp_id: 1, match: { fps: 30, width: 1920 } }), ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["compsettingsRead"]);
    expect(out.match).toEqual({ ok: false, differences: [{ field: "fps", wanted: 30, actual: 25 }] });
  });

  it("ae_comp_settings guards, reads, writes and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      compsettingsRead: [info(), info({ motion_blur: true, shutter_angle: 360 })],
      compsettingsApply: [{ comp_id: 1, changed: ["motion_blur", "shutter_angle"], guide_api: null, guides_applied: [] }],
    });
    const args = AeCompSettingsSchema.parse({ comp_id: 1, settings: { motion_blur: true, shutter_angle: 360 }, expect: expectArg });
    const out = (await tool("ae_comp_settings").handler(args, ctx)) as any;
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "compsettingsRead", "compsettingsApply", "compsettingsRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(true);
    expect(out.changed).toEqual(["motion_blur", "shutter_angle"]);
    expect(out.warning).toBeUndefined();
  });

  it("flags resolution changes and puts a failed read-back into the receipt instead of throwing", async () => {
    const { ctx } = fakeAe({
      compsettingsRead: [info(), new Error("AE busy")],
      compsettingsApply: [{ comp_id: 1, changed: ["resolution_factor"], resolution_factor_written: true, guides_applied: [] }],
    });
    const args = AeCompSettingsSchema.parse({ comp_id: 1, settings: { resolution_factor: [2, 2] }, expect: expectArg });
    const out = (await tool("ae_comp_settings").handler(args, ctx)) as any;
    expect(out.applied).toBe(true);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt)).toContain("Do not resend");
  });
});

// ---------- the host functions under node:vm ----------

/** A fake comp with the comp-level attributes, a guide list and AE's work-area limit. */
function richScene(opts: { guideApi?: "legacy" | "options" | "none" } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Main", 1920, 1080, 10);
  const c = comp as FakeComp & Record<string, any>;
  Object.assign(c, {
    motionBlur: false,
    shutterAngle: 180,
    shutterPhase: -90,
    motionBlurSamplesPerFrame: 16,
    motionBlurAdaptiveSampleLimit: 128,
    frameBlending: false,
    draft3d: false,
    hideShyLayers: false,
    preserveNestedFrameRate: false,
    preserveNestedResolution: false,
    displayStartFrame: 0,
    renderer: "ADBE Advanced 3d",
    renderers: ["ADBE Advanced 3d", "ADBE Calder"],
    resolutionFactor: [1, 1],
    bgColor: [0, 0, 0],
  });
  // AE throws when the work area would pass the comp's end.
  let start = 0;
  let dur = 10;
  const log: string[] = [];
  Object.defineProperty(c, "workAreaStart", {
    get: () => start,
    set: (v: number) => {
      if (v + dur > c.duration + 1e-9) throw new Error("work area out of range");
      log.push(`start=${v}`);
      start = v;
    },
  });
  Object.defineProperty(c, "workAreaDuration", {
    get: () => dur,
    set: (v: number) => {
      if (start + v > c.duration + 1e-9) throw new Error("work area out of range");
      log.push(`duration=${v}`);
      dur = v;
    },
  });
  const guides: Array<{ orientationType: number; positionType: number; position: number }> = [];
  const mode = opts.guideApi ?? "legacy";
  if (mode !== "none") {
    Object.defineProperty(c, "guides", { get: () => guides.map((g) => ({ ...g })) });
    c.addGuide = (a: any, b?: any) => {
      if (typeof a === "object") {
        if (mode === "legacy") throw new Error("legacy only");
        guides.push({ orientationType: a.orientationType, positionType: 0, position: a.position });
      } else {
        if (mode === "options") throw new Error("options only");
        guides.push({ orientationType: a, positionType: 0, position: b });
      }
      return guides.length - 1;
    };
    c.removeGuide = (i: number) => {
      if (!guides[i]) throw new Error("no such guide");
      guides.splice(i, 1);
    };
    c.setGuide = (a: any, b: any) => {
      if (typeof b === "object") {
        if (mode === "legacy") throw new Error("legacy only");
        guides[a].position = b.position;
      } else {
        if (mode === "options") throw new Error("options only");
        guides[b].position = a;
      }
    };
  }
  const host = loadHost(project, ["compsettings.jsx"]);
  return { project, comp: c, guides, workLog: log, ...host };
}

describe("compsettings.jsx", () => {
  it("reads every setting without touching the comp or the undo stack", () => {
    const { A, comp, undo } = richScene();
    const r = A.compsettingsRead({ comp_id: comp.id });
    expect(r).toMatchObject({
      motion_blur: false,
      shutter_angle: 180,
      motion_blur_samples: 16,
      renderer: "ADBE Advanced 3d",
      resolution_factor: [1, 1],
      background_color: [0, 0, 0],
      work_area: { start: 0, duration: 10 },
      guide_count: 0,
      fps: 25,
    });
    expect(r.renderers).toEqual(["ADBE Advanced 3d", "ADBE Calder"]);
    expect(undo.begun).toBe(0);
  });

  it("lists what the build can't read instead of failing", () => {
    const project = new FakeProject();
    const comp = project.addComp("Bare", 640, 360, 4);
    const { A } = loadHost(project, ["compsettings.jsx"]);
    const r = A.compsettingsRead({ comp_id: comp.id });
    expect(r.unreadable).toEqual(expect.arrayContaining(["motion_blur", "renderer", "resolution_factor", "guides"]));
    expect(r.width).toBe(640);
  });

  it("sets switches in one undo group", () => {
    const { A, comp, undo } = richScene();
    const out = A.compsettingsApply({
      comp_id: comp.id,
      settings: {
        motion_blur: true,
        shutter_angle: 270,
        shutter_phase: 0,
        motion_blur_samples: 32,
        frame_blending: true,
        draft_3d: true,
        hide_shy_layers: true,
        renderer: "ADBE Calder",
        resolution_factor: [2, 2],
        background_color: [0.1, 0.2, 0.3],
        display_start_frame: 100,
      },
      expect: GUARD,
    });
    expect(out.changed).toContain("renderer");
    expect(out.resolution_factor_written).toBe(true);
    expect(comp.motionBlur).toBe(true);
    expect(comp.shutterAngle).toBe(270);
    expect(comp.motionBlurSamplesPerFrame).toBe(32);
    expect(comp.renderer).toBe("ADBE Calder");
    expect(comp.resolutionFactor).toEqual([2, 2]);
    expect(comp.bgColor).toEqual([0.1, 0.2, 0.3]);
    expect(comp.displayStartFrame).toBe(100);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });

  it("validates everything before the undo group opens", () => {
    const { A, comp, undo } = richScene();
    const bad = (settings: object, re: RegExp) => expect(() => A.compsettingsApply({ comp_id: comp.id, settings, expect: GUARD })).toThrow(re);
    bad({ renderer: "Nope" }, /not installed.*ADBE Calder/);
    bad({ shutter_angle: 900 }, /at most 720/);
    bad({ shutter_angle: 1.5 }, /integer/);
    bad({ motion_blur: "yes" }, /true or false/);
    bad({ resolution_factor: [1] }, /\[x, y\]/);
    bad({ background_color: [1, 1, 5] }, /0\.\.1/);
    bad({ display_start_time: 1, display_start_frame: 25 }, /not both/);
    bad({ bogus: 1 }, /Unknown setting/);
    bad({ motion_blur_samples: 64, motion_blur_adaptive_limit: 16 }, /cannot be above/);
    expect(undo.begun).toBe(0);
    bad({ work_area: { start: 8, duration: 5 } }, /past the comp's length/);
    bad({ work_area: { duration: 0.01 } }, /shorter than one frame/);
    expect(() => A.compsettingsApply({ comp_id: comp.id, expect: GUARD })).toThrow(/Nothing to change/);
    expect(() => A.compsettingsApply({ comp_id: comp.id, settings: { motion_blur: true }, expect: { project_path: "C:/other.aep" } })).toThrow(/Target guard refused/);
    expect(comp.motionBlur).toBe(false);
    expect(undo.begun).toBe(0);
  });

  it("refuses a setting the AE build lacks (start frame before 17.1)", () => {
    const { A, comp } = richScene();
    delete (comp as any).displayStartFrame;
    expect(() => A.compsettingsApply({ comp_id: comp.id, settings: { display_start_frame: 5 }, expect: GUARD })).toThrow(/not available/);
  });

  it("orders work-area writes so the area never passes the comp's end", () => {
    const { A, comp, workLog } = richScene();
    // Moving the start later while shortening: a naive start-first write would throw.
    A.compsettingsApply({ comp_id: comp.id, settings: { work_area: { start: 6, duration: 4 } }, expect: GUARD });
    expect(comp.workAreaStart).toBe(6);
    expect(comp.workAreaDuration).toBe(4);
    // And widening back from the front.
    A.compsettingsApply({ comp_id: comp.id, settings: { work_area: { start: 0, duration: 10 } }, expect: GUARD });
    expect(comp.workAreaStart).toBe(0);
    expect(comp.workAreaDuration).toBe(10);
    expect(workLog.length).toBeGreaterThan(0);
  });

  it("keeps the other half of the work area when only one is given", () => {
    const { A, comp } = richScene();
    A.compsettingsApply({ comp_id: comp.id, settings: { work_area: { duration: 4 } }, expect: GUARD });
    expect(comp.workAreaStart).toBe(0);
    expect(comp.workAreaDuration).toBe(4);
    expect(() => A.compsettingsApply({ comp_id: comp.id, settings: { work_area: { start: 6 } }, expect: GUARD })).not.toThrow();
    expect(() => A.compsettingsApply({ comp_id: comp.id, settings: { work_area: { start: 7 } }, expect: GUARD })).toThrow(/past the comp's length/);
  });

  it("adds, moves and removes guides in order", () => {
    const { A, comp, guides, undo } = richScene();
    const out = A.compsettingsApply({
      comp_id: comp.id,
      guides: [
        { action: "add", orientation: "vertical", position: 960 },
        { action: "add", orientation: "horizontal", position: 540 },
        { action: "set", index: 0, position: 100 },
        { action: "remove", index: 1 },
      ],
      expect: GUARD,
    });
    expect(out.guide_api).toBe("legacy");
    expect(guides).toEqual([{ orientationType: 1, positionType: 0, position: 100 }]);
    expect(out.guides_applied).toHaveLength(4);
    expect(undo.begun).toBe(1);
    const r = A.compsettingsRead({ comp_id: comp.id });
    expect(r.guide_count).toBe(1);
    expect(r.guides[0]).toMatchObject({ index: 0, orientation_type: 1, position: 100 });
  });

  it("falls back to the options form on a build that only has that one", () => {
    const { A, comp, guides } = richScene({ guideApi: "options" });
    const out = A.compsettingsApply({
      comp_id: comp.id,
      guides: [
        { action: "add", orientation: "horizontal", position: 50 },
        { action: "set", index: 0, position: 60 },
      ],
      expect: GUARD,
    });
    expect(out.guide_api).toBe("options");
    expect(guides[0].position).toBe(60);
  });

  it("refuses bad guide indexes (by the count at each step) before changing anything", () => {
    const { A, comp, guides, undo } = richScene();
    const run = (ops: object[]) => A.compsettingsApply({ comp_id: comp.id, guides: ops, expect: GUARD });
    expect(() => run([{ action: "set", index: 0, position: 5 }])).toThrow(/guide count at that step is 0/);
    expect(() => run([{ action: "add", orientation: "vertical", position: 1 }, { action: "remove", index: 0 }, { action: "remove", index: 0 }])).toThrow(/guides\[2\]/);
    expect(() => run([{ action: "add", orientation: "diagonal", position: 1 }])).toThrow(/Unknown guide orientation/);
    expect(() => run([{ action: "add", orientation: "vertical", position: 999999 }])).toThrow(/within/);
    expect(guides).toEqual([]);
    expect(undo.begun).toBe(0);
  });

  it("says so when the build has no guide API", () => {
    const { A, comp } = richScene({ guideApi: "none" });
    expect(() => A.compsettingsApply({ comp_id: comp.id, guides: [{ action: "add", orientation: "vertical", position: 1 }], expect: GUARD })).toThrow(/does not expose Item\.guides/);
  });

  it("read tools of other groups see the new fields (getComp)", () => {
    const { A, comp } = richScene();
    const c = A.getComp({ comp_id: comp.id });
    expect(c).toMatchObject({ motionBlur: false, shutterAngle: 180, renderer: "ADBE Advanced 3d", resolutionFactor: [1, 1] });
  });
});

describe("compsettings review fixes", () => {
  it("refuses samples above the comp's current adaptive limit before the undo group", () => {
    const { A, comp, undo } = richScene();
    comp.motionBlurAdaptiveSampleLimit = 16;
    expect(() => A.compsettingsApply({ comp_id: comp.id, settings: { motion_blur_samples: 64 }, expect: GUARD })).toThrow(/cannot be above/);
    expect(undo.begun).toBe(0);
    expect(comp.motionBlurSamplesPerFrame).toBe(16);
  });

  it("refuses an out-of-range display_start_frame before the undo group opens", () => {
    const { A, comp, undo, guides } = richScene();
    const run = (settings: object) =>
      A.compsettingsApply({
        comp_id: comp.id,
        settings,
        guides: [{ action: "add", orientation: "vertical", position: 5 }],
        expect: GUARD,
      });
    expect(() => run({ display_start_frame: 1e9 })).toThrow(/AE accepts -10800\.\.86339s/);
    expect(() => run({ display_start_frame: -1e9 })).toThrow(/AE accepts/);
    expect(undo.begun).toBe(0);
    expect(guides).toEqual([]);
    // 25 fps: 86339 s is frame 2158475.
    A.compsettingsApply({ comp_id: comp.id, settings: { display_start_frame: 2158475 }, expect: GUARD });
    expect(comp.displayStartFrame).toBe(2158475);
  });

  it("refuses a renderer when the renderers list can't be read, and probes guide methods early", () => {
    const { A, comp, undo } = richScene();
    delete (comp as any).renderers;
    expect(() => A.compsettingsApply({ comp_id: comp.id, settings: { renderer: "ADBE Calder" }, expect: GUARD })).toThrow(/renderers list is unavailable/);
    expect(undo.begun).toBe(0);
    expect(comp.renderer).toBe("ADBE Advanced 3d");
    const s2 = richScene();
    delete (s2.comp as any).addGuide;
    expect(() => s2.A.compsettingsApply({ comp_id: s2.comp.id, guides: [{ action: "add", orientation: "vertical", position: 1 }], expect: GUARD })).toThrow(/no addGuide method/);
    expect(s2.undo.begun).toBe(0);
  });

  it("writes the adaptive limit around the samples so a clamping AE ends up right", () => {
    const { A, comp } = richScene();
    let limit = 16;
    let samples = 16;
    Object.defineProperty(comp, "motionBlurAdaptiveSampleLimit", { get: () => limit, set: (v: number) => { limit = v; } });
    Object.defineProperty(comp, "motionBlurSamplesPerFrame", { get: () => samples, set: (v: number) => { samples = Math.min(v, limit); } });
    const out = A.compsettingsApply({ comp_id: comp.id, settings: { motion_blur_samples: 64, motion_blur_adaptive_limit: 256 }, expect: GUARD });
    expect(samples).toBe(64);
    expect(limit).toBe(256);
    expect(out.changed).toEqual(expect.arrayContaining(["motion_blur_samples", "motion_blur_adaptive_limit"]));
  });

  it("flags guide orientation as unverified on 26.5+ when the DOM has no enum, not before", () => {
    const op = { action: "add", orientation: "horizontal", position: 10 };
    const old = richScene();
    expect(old.A.compsettingsApply({ comp_id: old.comp.id, guides: [op], expect: GUARD }).guide_orientation_unverified).toBeUndefined();
    const project = new FakeProject();
    const comp = project.addComp("Main", 1920, 1080, 10) as FakeComp & Record<string, any>;
    const gl: any[] = [];
    Object.defineProperty(comp, "guides", { get: () => gl.slice() });
    comp.addGuide = (o: number, p: number) => { gl.push({ orientationType: o, positionType: 0, position: p }); return gl.length - 1; };
    const { A } = loadHost(project, ["compsettings.jsx"], { version: "26.5.0x12" });
    const out = A.compsettingsApply({ comp_id: comp.id, guides: [op], expect: GUARD });
    expect(out.guide_orientation_unverified).toBe(true);
    expect(gl).toHaveLength(1);
  });

  it("skips position checks for guides that read back in another position type", () => {
    const args = { comp_id: 1, guides: [{ action: "add", orientation: "vertical", position: 100 }], expect: expectArg } as any;
    const before = info({ guides: [{ index: 0, orientation_type: 1, position_type: 1, position: 50 }], guide_count: 1 });
    const after = info({
      guides: [
        { index: 0, orientation_type: 1, position_type: 1, position: 50 },
        { index: 1, orientation_type: 1, position_type: 0, position: 100 },
      ],
      guide_count: 2,
    });
    const written = { guides_applied: [{ action: "add", orientation_type: 1, position: 100 }] };
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
    after.guides[0].position = 7; // other type than the added one: not comparable
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
    after.guides[1].position = 7; // same type as the added one: compared
    expect(compSettingsMismatches(args, before, after, written).length).toBeGreaterThan(0);
  });

  it("fingerprint.jsx carries the comp switches and the guide list", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 300 });
    const fpHost = loadHost(s.project, ["compsettings.jsx", "fingerprint.jsx"]);
    const fp = JSON.parse(JSON.stringify(fpHost.A.compFingerprint({ comp_id: s.comp.id })));
    expect(fp.motionBlur).toBe(false);
    expect(fp.renderer).toBe("ADBE Advanced 3d");
    expect(fp.guides).toEqual([{ orientationType: 1, position: 300 }]);
    expect(fp.guides_truncated).toBeUndefined();
  });

  it("host read, apply and read feed compSettingsMismatches without a key-name gap", () => {
    const { A, comp } = richScene();
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    const args = {
      comp_id: comp.id,
      settings: { work_area: { start: 2, duration: 5 }, motion_blur: true },
      guides: [
        { action: "add", orientation: "vertical", position: 960 },
        { action: "add", orientation: "horizontal", position: 540 },
        { action: "set", index: 0, position: 100 },
      ],
      expect: expectArg,
    } as any;
    const before = json(A.compsettingsRead({ comp_id: comp.id }));
    const written = json(A.compsettingsApply({ comp_id: comp.id, settings: args.settings, guides: args.guides, expect: GUARD }));
    const after = json(A.compsettingsRead({ comp_id: comp.id }));
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
    expect(after.guide_count).toBe(2);
  });
});
