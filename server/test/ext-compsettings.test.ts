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
  anchorDelta,
  compareToBrief,
  durationSeconds,
  guideOrientationName,
  guidePositionKindName,
  isDropFrameRate,
  compSettingsMismatches,
  compsettingsTools,
  simulateGuides,
  type CompSettingsInfo,
} from "../src/tools/ext/compsettings.js";
import { FakeProject, FakeProperty, FileSource, GUARD, loadHost, PropertyValueType, type FakeComp } from "./support/fake-ae.js";

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
function richScene(opts: { guideApi?: "legacy" | "options" | "none"; version?: string } = {}) {
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
    dropFrame: false,
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
        // AE 26.5's GuideOptions carries `orientation`, not `orientationType`.
        if (a.orientationType !== undefined || typeof a.orientation !== "number") throw new Error("bad GuideOptions");
        guides.push({ orientationType: a.orientation, positionType: 0, position: a.position });
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
  const host = loadHost(project, ["compsettings.jsx"], opts.version ? { version: opts.version } : {});
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
    const before = info({ guides: [{ index: 0, orientation_type: 1, position_type: 1, position_kind: "percentage", position: 50 }], guide_count: 1 });
    const after = info({
      guides: [
        { index: 0, orientation_type: 1, position_type: 1, position_kind: "percentage", position: 50 },
        { index: 1, orientation_type: 1, position_type: 0, position_kind: "pixel", position: 100 },
      ],
      guide_count: 2,
    });
    const written = { guides_applied: [{ action: "add", orientation_type: 1, position: 100 }] };
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
    after.guides[0].position = 7; // an untouched guide that moved is a real difference
    expect(compSettingsMismatches(args, before, after, written).length).toBeGreaterThan(0);
    after.guides[0].position_kind = "pixel"; // the kinds differ: not comparable
    const paths = compSettingsMismatches(args, before, after, written).map((x) => x.path);
    expect(paths).toContain("guides[0].position_kind");
    expect(paths).not.toContain("guides[0].position");
    after.guides[0].position = 50;
    after.guides[0].position_kind = "percentage";
    after.guides[1].position = 7; // same type as the added one: compared
    expect(compSettingsMismatches(args, before, after, written).map((x) => x.path)).toEqual(["guides[1].position"]);
  });

  it("compares each guide by its own position type: a pixel set hides behind a percentage add no more", () => {
    const args = {
      comp_id: 1,
      guides: [
        { action: "add", orientation: "vertical", position: 50, position_type: "percentage" },
        { action: "set", index: 0, position: 500 },
      ],
      expect: expectArg,
    } as any;
    const before = info({ guides: [{ index: 0, orientation: "vertical", position_kind: "pixel", position: 100 }], guide_count: 1 });
    const written = {
      guides_applied: [
        { action: "add", orientation: "vertical", orientation_type: 1, position: 50, position_kind: "percentage" },
        { action: "set", index: 0, position: 500 },
      ],
    };
    const mk = (p0: number) =>
      info({
        guides: [
          { index: 0, orientation: "vertical", position_kind: "pixel", position: p0 },
          { index: 1, orientation: "vertical", position_kind: "percentage", position: 50 },
        ],
        guide_count: 2,
      });
    expect(compSettingsMismatches(args, before, mk(500), written)).toEqual([]);
    expect(compSettingsMismatches(args, before, mk(9999), written).map((x) => x.path)).toContain("guides[0].position");
  });

  it("does not compare a pinned guide no step wrote after a resize, but compares one the user wrote", () => {
    const args = { comp_id: 1, settings: { size: { width: 1080, height: 1920 } }, guides: [{ action: "add", orientation: "vertical", position: 900, pinned: true }], expect: expectArg } as any;
    const g = (index: number, position: number, pinned: boolean) => ({ index, orientation: "vertical", position_kind: "pixel", position, pinned });
    const before = info({ guide_count: 2, guides: [g(0, 960, true), g(1, 100, false)] });
    const size = { width: 1080, height: 1920 };
    const written = {
      changed: ["guides", "size"],
      guides_applied: [{ action: "add", orientation: "vertical", orientation_type: 1, position: 900, pinned: true }],
      guide_shifts: [
        { action: "set", index: 1, position: -320 },
        { action: "set", index: 2, position: 900 },
      ],
      resize: { layers_moved: 0 },
    };
    const mk = (p0: number, p1: number, p2: number) => info({ ...size, guide_count: 3, guides: [g(0, p0, true), g(1, p1, false), g(2, p2, true)] });
    // The untouched pinned guide moved with AE's edge rule (960 -> 540); the unpinned one shifted; the user's pinned add stayed at 900.
    expect(compSettingsMismatches(args, before, mk(540, -320, 900), written)).toEqual([]);
    expect(compSettingsMismatches(args, before, mk(540, 0, 900), written).map((x) => x.path)).toEqual(["guides[1].position"]);
    // The user's pinned guide that AE left at the edge-kept position is a real miss.
    expect(compSettingsMismatches(args, before, mk(540, -320, 60), written).map((x) => x.path)).toEqual(["guides[2].position"]);
  });

  it("moves a camera or light with the resize even when hasVideo reads false", () => {
    const s = richScene();
    const cam = s.comp.layers.addCamera("Cam", [0, 0]) as Rec;
    cam.matchName = "ADBE Camera Layer";
    cam.hasVideo = false;
    const l = addLayer(s, "Voice");
    l.hasVideo = false;
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1080, height: 1920 } }, expect: GUARD });
    expect(out.resize.layers_moved).toBe(1);
    expect(out.resize.layers_skipped).toEqual([expect.objectContaining({ name: "Voice", reason: expect.stringMatching(/audio-only/) })]);
  });

  it("fingerprint.jsx carries the comp switches and the guide list", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 300 });
    const fpHost = loadHost(s.project, ["compsettings.jsx", "fingerprint.jsx"]);
    const fp = JSON.parse(JSON.stringify(fpHost.A.compFingerprint({ comp_id: s.comp.id })));
    expect(fp.motionBlur).toBe(false);
    expect(fp.renderer).toBe("ADBE Advanced 3d");
    // Stable words, not AE's version-dependent integers.
    expect(fp.guides).toEqual([{ orientation: "vertical", position: 300, position_kind: "pixel" }]);
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

// ---------- dialog edits and 26.5 guides (w5compsettings) ----------

describe("dialog-edit schemas", () => {
  const parse = (settings: unknown) => AeCompSettingsSchema.safeParse({ comp_id: 1, settings, expect: expectArg });

  it("accepts the new settings and fills defaults", () => {
    const r = AeCompSettingsSchema.parse({
      comp_id: 1,
      settings: {
        name: "Hero",
        size: { width: 1080, height: 1920 },
        pixel_aspect: 1.5,
        frame_rate: 29.97,
        drop_frame: true,
        duration: { frames: 300 },
      },
      expect: expectArg,
    });
    expect(r.settings?.size?.anchor).toBe("center");
    expect(r.settings?.duration?.extend_layers).toBe(true);
    expect(parse({ trim_to_work_area: true }).success).toBe(true);
    expect(parse({ size: { width: 100, height: 100, anchor: "bottom_right" } }).success).toBe(true);
  });

  it("rejects out-of-range or malformed values", () => {
    for (const settings of [
      { name: "" },
      { size: { width: 3, height: 100 } },
      { size: { width: 30001, height: 100 } },
      { size: { width: 100.5, height: 100 } },
      { size: { width: 100 } },
      { size: { width: 100, height: 100, anchor: "middle" } },
      { pixel_aspect: 0 },
      { pixel_aspect: 101 },
      { frame_rate: 0.5 },
      { frame_rate: 100 },
      { duration: {} },
      { duration: { seconds: 5, frames: 100 } },
      { duration: { seconds: 10801 } },
      { duration: { seconds: 0 } },
      { duration: { frames: 1.5 } },
      { drop_frame: "yes" },
      { trim_to_work_area: false },
      { trim_to_work_area: true, duration: { seconds: 5 } },
      { trim_to_work_area: true, work_area: { start: 1 } },
      { trim_to_work_area: true, display_start_time: 5 },
    ]) {
      expect(parse(settings).success, JSON.stringify(settings)).toBe(false);
    }
  });

  it("accepts 26.5 guide options and keeps remove strict", () => {
    const g = (guides: unknown[]) => AeCompSettingsSchema.safeParse({ comp_id: 1, guides, expect: expectArg }).success;
    expect(g([{ action: "add", orientation: "vertical", position: 50, position_type: "percentage", color: [1, 0, 0], pinned: true }])).toBe(true);
    expect(g([{ action: "set", index: 0, position: 10, pinned: false }])).toBe(true);
    expect(g([{ action: "add", orientation: "vertical", position: 50, color: [1, 0] }])).toBe(false);
    expect(g([{ action: "add", orientation: "vertical", position: 50, color: [1, 0, 2] }])).toBe(false);
    expect(g([{ action: "add", orientation: "vertical", position: 50, position_type: "percent" }])).toBe(false);
    expect(g([{ action: "remove", index: 0, pinned: true }])).toBe(false);
  });

  it("describes the new settings and still ends with the safety guidance", () => {
    const d = tool("ae_comp_settings").description;
    expect(d).toContain("trim_to_work_area");
    expect(d).toContain("target guard failure");
    expect(tool("ae_get_comp_settings").description).toContain("position_kind");
  });
});

describe("dialog-edit pure helpers", () => {
  it("anchorDelta gives each anchor's share of the change", () => {
    const from = { width: 1920, height: 1080 };
    const to = { width: 1080, height: 1920 };
    expect(anchorDelta(from, to)).toEqual({ dx: -420, dy: 420 });
    expect(anchorDelta(from, to, "top_left")).toEqual({ dx: -0, dy: 0 });
    expect(anchorDelta(from, to, "bottom_right")).toEqual({ dx: -840, dy: 840 });
    expect(anchorDelta(from, to, "top")).toEqual({ dx: -420, dy: 0 });
    expect(anchorDelta(from, to, "left")).toEqual({ dx: -0, dy: 420 });
  });

  it("isDropFrameRate, durationSeconds", () => {
    expect(isDropFrameRate(29.97)).toBe(true);
    expect(isDropFrameRate(30000 / 1001)).toBe(true);
    expect(isDropFrameRate(59.94)).toBe(true);
    expect(isDropFrameRate(25)).toBe(false);
    expect(isDropFrameRate(30)).toBe(false);
    expect(durationSeconds({ seconds: 4 }, 25)).toBe(4);
    expect(durationSeconds({ frames: 100 }, 25)).toBe(4);
    expect(durationSeconds({}, 25)).toBeNull();
  });

  it("guide enum mapping prefers the enum over the legacy integers", () => {
    expect(guideOrientationName(1)).toBe("vertical");
    expect(guideOrientationName(0)).toBe("horizontal");
    expect(guideOrientationName(1, { HORIZONTAL: 1, VERTICAL: 0 })).toBe("horizontal");
    expect(guideOrientationName(5, { HORIZONTAL: 1, VERTICAL: 0 })).toBeNull();
    expect(guidePositionKindName(0)).toBe("pixel");
    expect(guidePositionKindName(1, { PIXEL: 1, PERCENTAGE: 0 })).toBe("pixel");
    expect(guidePositionKindName(0, { PIXEL: 1, PERCENTAGE: 0 })).toBe("percentage");
  });

  it("simulateGuides carries position kind, colour and pinned through add and set", () => {
    const list = simulateGuides(
      [{ orientation: "vertical", position: 10 }],
      [
        { action: "add", orientation: "horizontal", position: 50, position_kind: "percentage", color: [1, 0, 0], pinned: true },
        { action: "set", index: 0, position: 20, pinned: true },
      ]
    );
    expect(list[0]).toMatchObject({ orientation: "vertical", position: 20, pinned: true });
    expect(list[1]).toMatchObject({ orientation: "horizontal", position_kind: "percentage", color: [1, 0, 0], added: true });
  });
});

describe("dialog-edit receipt checks", () => {
  const parse = (v: object) => AeCompSettingsSchema.parse({ comp_id: 1, expect: expectArg, ...v });
  const ls = (id: number, extra: object = {}) => ({ id, index: id, in: 0, out: 10, start: 0, position: [960, 540], ...extra });

  it("checks name, size, pixel aspect, frame rate and drop frame, and allows them to change", () => {
    const args = parse({ settings: { name: "B", size: { width: 1080, height: 1920 }, pixel_aspect: 1.5, frame_rate: 29.97, drop_frame: true } });
    const good = info({ name: "B", width: 1080, height: 1920, pixel_aspect: 1.5, fps: 29.97, drop_frame: true });
    expect(compSettingsMismatches(args, info({ pixel_aspect: 1, drop_frame: false }), good, {})).toEqual([]);
    const bad = info({ name: "Main", width: 1920, height: 1080, pixel_aspect: 1, fps: 25, drop_frame: false });
    expect(compSettingsMismatches(args, info({ pixel_aspect: 1, drop_frame: false }), bad, {}).map((x) => x.path)).toEqual(
      expect.arrayContaining(["settings.name", "settings.size.width", "settings.size.height", "settings.pixel_aspect", "settings.frame_rate", "settings.drop_frame"])
    );
  });

  it("still flags a size, rate or length change that was not asked for", () => {
    const args = parse({ settings: { name: "B" } });
    const paths = compSettingsMismatches(args, info(), info({ name: "B", width: 100, fps: 30, duration: 5 }), {}).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["width", "fps", "duration"]));
    // A frame-rate change may snap the length by a frame but no more.
    const fr = parse({ settings: { frame_rate: 30 } });
    expect(compSettingsMismatches(fr, info(), info({ fps: 30, frame_duration: 1 / 30, duration: 10.03 }), {})).toEqual([]);
    expect(compSettingsMismatches(fr, info(), info({ fps: 30, frame_duration: 1 / 30, duration: 11 }), {}).map((x) => x.path)).toEqual(["duration"]);
  });

  it("checks that each moved layer shifted by the anchor delta and the others stayed", () => {
    const args = parse({ settings: { size: { width: 1080, height: 1920 } } });
    const before = info({ layer_state: [ls(1), ls(2, { position: [100, 100] })] });
    const written = { resize: { layers_moved: 1 }, moved_layers: [{ id: 1, dx: -420, dy: 420 }] };
    const good = info({ width: 1080, height: 1920, layer_state: [ls(1, { position: [540, 960] }), ls(2, { position: [100, 100] })] });
    expect(compSettingsMismatches(args, before, good, written)).toEqual([]);
    // AE shifted the layer itself as well: the host's shift doubled up.
    const doubled = info({ width: 1080, height: 1920, layer_state: [ls(1, { position: [120, 1380] }), ls(2, { position: [100, 100] })] });
    expect(compSettingsMismatches(args, before, doubled, written).map((x) => x.path)).toEqual(["layers[1].position"]);
    const strayed = info({ width: 1080, height: 1920, layer_state: [ls(1, { position: [540, 960] }), ls(2, { position: [90, 100] })] });
    expect(compSettingsMismatches(args, before, strayed, written).map((x) => x.path)).toEqual(["layers[2].position"]);
  });

  it("checks extended and skipped layers and the new length", () => {
    const args = parse({ settings: { duration: { seconds: 12 } } });
    const before = info({ layer_state: [ls(1), ls(2)] });
    const written = { duration_change: { to: 12, extended: [{ id: 1, to: 12 }], skipped: [{ id: 2 }] } };
    const good = info({ duration: 12, layer_state: [ls(1, { out: 12 }), ls(2)] });
    expect(compSettingsMismatches(args, before, good, written)).toEqual([]);
    const bad = info({ duration: 12, layer_state: [ls(1), ls(2, { out: 12 })] });
    expect(compSettingsMismatches(args, before, bad, written).map((x) => x.path)).toEqual(["layers[1].out", "layers[2].out"]);
  });

  it("checks a trim: length, work area restart and every layer shifted", () => {
    const args = parse({ settings: { trim_to_work_area: true } });
    const before = info({ work_area: { start: 2, duration: 4 }, layer_state: [ls(1, { in: 1, out: 8 })] });
    const written = { trim: { shifted_by: 2, new_duration: 4 } };
    const good = info({ duration: 4, work_area: { start: 0, duration: 4 }, layer_state: [ls(1, { in: -1, out: 6 })] });
    expect(compSettingsMismatches(args, before, good, written)).toEqual([]);
    const bad = info({ duration: 10, work_area: { start: 2, duration: 4 }, layer_state: [ls(1, { in: 1, out: 8 })] });
    const paths = compSettingsMismatches(args, before, bad, written).map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(["settings.trim_to_work_area.duration", "settings.trim_to_work_area.work_area_start", "layers[1].in", "layers[1].out"]));
  });

  it("compares guides by their words and falls back to the integers only when a side has none", () => {
    const args = parse({ guides: [{ action: "add", orientation: "vertical", position: 960 }] });
    const written = { guides_applied: [{ action: "add", orientation_type: 20, orientation: "vertical", position: 960 }] };
    const after = (o: string) => info({ guide_count: 1, guides: [{ index: 0, orientation_type: 5, orientation: o as any, position: 960 }] });
    expect(compSettingsMismatches(args, info(), after("vertical"), written)).toEqual([]);
    expect(compSettingsMismatches(args, info(), after("horizontal"), written).map((x) => x.path)).toEqual(["guides[0].orientation"]);
  });

  it("applies the resize's guide shifts before the guide operations, and checks colour and pinned", () => {
    const args = parse({
      settings: { size: { width: 1080, height: 1920 } },
      guides: [{ action: "add", orientation: "horizontal", position: 100, color: [1, 0, 0], pinned: true, position_type: "pixel" }],
    });
    const before = info({ guide_count: 1, guides: [{ index: 0, orientation: "vertical", position_kind: "pixel", position: 960 }] });
    const written = {
      guide_shifts: [{ action: "set", index: 0, position: 540 }],
      guides_applied: [{ action: "add", orientation: "horizontal", orientation_type: 0, position: 100, position_kind: "pixel", color: [1, 0, 0], pinned: true }],
    };
    const good = info({
      width: 1080,
      height: 1920,
      guide_count: 2,
      guides: [
        { index: 0, orientation: "vertical", position_kind: "pixel", position: 540 },
        { index: 1, orientation: "horizontal", position_kind: "pixel", position: 100, color: [1, 0, 0], pinned: true },
      ],
    });
    expect(compSettingsMismatches(args, before, good, written)).toEqual([]);
    good.guides[1].pinned = false;
    good.guides[1].color = [0, 0, 1];
    expect(compSettingsMismatches(args, before, good, written).map((x) => x.path)).toEqual(["guides[1].color", "guides[1].pinned"]);
  });
});

describe("dialog-edit tool handler", () => {
  it("asks for per-layer state in both reads when layers can move, and hides it from the result", async () => {
    const withState = info({ layer_state: [{ id: 5, index: 1, in: 0, out: 10, start: 0, position: [960, 540] }] });
    const { ctx, calls } = fakeAe({
      compsettingsRead: [withState, info({ width: 1080, height: 1920, layer_state: [{ id: 5, index: 1, in: 0, out: 10, start: 0, position: [540, 960] }] })],
      compsettingsApply: [{ comp_id: 1, changed: ["size"], guides_applied: [], moved_layers: [{ id: 5, dx: -420, dy: 420 }], resize: { layers_moved: 1 }, guide_shifts: [] }],
    });
    const args = AeCompSettingsSchema.parse({ comp_id: 1, settings: { size: { width: 1080, height: 1920 } }, expect: expectArg });
    const out = (await tool("ae_comp_settings").handler(args, ctx)) as any;
    expect(calls.filter((c) => c.fn === "compsettingsRead").every((c) => c.script.includes('"layer_state":true'))).toBe(true);
    expect(calls[2].script).toContain('"anchor":"center"');
    expect(out.receipt.matches).toBe(true);
    expect(out.resize).toEqual({ layers_moved: 1 });
    expect(out.settings.layer_state).toBeUndefined();
  });

  it("does not ask for layer state when only plain switches change", async () => {
    const { ctx, calls } = fakeAe({
      compsettingsRead: [info(), info({ frame_blending: true })],
      compsettingsApply: [{ comp_id: 1, changed: ["frame_blending"], guides_applied: [] }],
    });
    await tool("ae_comp_settings").handler(AeCompSettingsSchema.parse({ comp_id: 1, settings: { frame_blending: true }, expect: expectArg }), ctx);
    expect(calls.some((c) => c.script.includes("layer_state"))).toBe(false);
  });

  it("passes a no-op host result through", async () => {
    const { ctx } = fakeAe({
      compsettingsRead: [info(), info()],
      compsettingsApply: [{ comp_id: 1, changed: [], guides_applied: [], no_op: true, notes: ["Everything asked for was already set"] }],
    });
    const out = (await tool("ae_comp_settings").handler(AeCompSettingsSchema.parse({ comp_id: 1, settings: { name: "Main" }, expect: expectArg }), ctx)) as any;
    expect(out.no_op).toBe(true);
    expect(out.notes).toEqual(["Everything asked for was already set"]);
    expect(out.receipt.matches).toBe(true);
  });
});

// ---------- host: dialog edits under node:vm ----------

type Rec = Record<string, any>;

/** Adds a solid layer with the given Position. */
function addLayer(s: ReturnType<typeof richScene>, name: string, pos: number[] = [960, 540, 0]) {
  const l = s.comp.layers.addSolid([1, 1, 1], name, 100, 100, 1) as Rec;
  l.transform("Position").staticValue = pos;
  return l;
}

const posOf = (l: Rec) => l.transform("Position") as Rec;

describe("compsettings.jsx: anchored resize", () => {
  it("moves top-level layers by the anchor's share, keys included, parented layers follow", () => {
    const s = richScene();
    const a = addLayer(s, "A", [960, 540, 0]);
    const keyed = addLayer(s, "Keyed", [100, 100, 0]);
    posOf(keyed).setValueAtTime(0, [100, 100, 5]);
    posOf(keyed).setValueAtTime(1, [200, 300, 7]);
    const child = addLayer(s, "Child", [10, 10, 0]);
    child.parent = a;
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1080, height: 1920, anchor: "center" } }, expect: GUARD });
    expect(s.comp.width).toBe(1080);
    expect(s.comp.height).toBe(1920);
    expect(posOf(a).staticValue).toEqual([540, 960, 0]);
    expect(posOf(keyed).keys.map((k: Rec) => k.value)).toEqual([
      [-320, 520, 5],
      [-220, 720, 7],
    ]);
    expect(posOf(child).staticValue).toEqual([10, 10, 0]);
    expect(out.resize).toMatchObject({ from: [1920, 1080], to: [1080, 1920], anchor: "center", delta: [-420, 420], layers_moved: 2, layers_parented: 1 });
    expect(out.moved_layers).toHaveLength(2);
    expect(out.changed).toContain("size");
    expect(s.undo).toMatchObject({ begun: 1, ended: 1 });
  });

  it("anchors at a corner and leaves a top-left resize alone", () => {
    const s = richScene();
    const a = addLayer(s, "A", [960, 540, 0]);
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1000, height: 1000, anchor: "bottom_right" } }, expect: GUARD });
    expect(posOf(a).staticValue).toEqual([40, 460, 0]);
    const t = richScene();
    const b = addLayer(t, "B", [960, 540, 0]);
    const out = t.A.compsettingsApply({ comp_id: t.comp.id, settings: { size: { width: 1000, height: 1000, anchor: "top_left" } }, expect: GUARD });
    expect(posOf(b).staticValue).toEqual([960, 540, 0]);
    expect(out.resize.layers_moved).toBe(0);
  });

  it("unlocks a locked layer for the move and locks it again", () => {
    const s = richScene();
    const a = addLayer(s, "A");
    a.locked = true;
    let lockedDuring: boolean | null = null;
    const pos = posOf(a);
    const orig = pos.setValue.bind(pos);
    pos.setValue = (v: unknown) => {
      lockedDuring = a.locked;
      orig(v);
    };
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1000, height: 1080 } }, expect: GUARD });
    expect(lockedDuring).toBe(false);
    expect(a.locked).toBe(true);
    expect(posOf(a).staticValue).toEqual([500, 540, 0]);
  });

  it("follows separated dimensions and moves a camera's point of interest", () => {
    const s = richScene();
    const a = addLayer(s, "Sep", [960, 540, 0]);
    const tr = a.group.property("ADBE Transform Group");
    const mk = (name: string, mn: string, v: number) => {
      const p = new FakeProperty(name, mn, PropertyValueType.OneD, v);
      p.parentProperty = tr;
      tr.props.push(p);
      return p;
    };
    const px = mk("X Position", "ADBE Position_0", 960);
    const py = mk("Y Position", "ADBE Position_1", 540);
    px.setValueAtTime(0, 960);
    px.setValueAtTime(1, 1000);
    posOf(a).dimensionsSeparated = true;
    const cam = s.comp.layers.addCamera("Cam", [0, 0]) as Rec;
    cam.matchName = "ADBE Camera Layer";
    cam.transform("Position").staticValue = [960, 540, -1000];
    cam.transform("Anchor Point").staticValue = [960, 540, 0];
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1920, height: 1280 } }, expect: GUARD });
    expect(px.keys.map((k: Rec) => k.value)).toEqual([960, 1000]);
    expect(py.staticValue).toBe(640);
    expect(cam.transform("Position").staticValue).toEqual([960, 640, -1000]);
    expect(cam.transform("Anchor Point").staticValue).toEqual([960, 640, 0]);
  });

  it("skips layers driven by a Position expression and says so", () => {
    const s = richScene();
    const a = addLayer(s, "Wig");
    posOf(a).expressionEnabled = true;
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1000, height: 1000 } }, expect: GUARD });
    expect(posOf(a).staticValue).toEqual([960, 540, 0]);
    expect(out.resize.layers_skipped).toEqual([expect.objectContaining({ name: "Wig", reason: expect.stringMatching(/expression/) })]);
  });

  it("shifts pixel guides with the content, leaving percentage ones", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 100 }, { orientationType: 0, positionType: 0, position: 200 }, { orientationType: 1, positionType: 1, position: 50 });
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1080, height: 1920 } }, expect: GUARD });
    expect(s.guides.map((g) => g.position)).toEqual([-320, 620, 50]);
    expect(out.guide_shifts).toEqual([
      { action: "set", index: 0, position: -320, keep: { orientation: 1, position_type: 0 } },
      { action: "set", index: 1, position: 620, keep: { orientation: 0, position_type: 0 } },
    ]);
  });

  it("skips audio-only layers before the undo group instead of throwing mid-resize", () => {
    const s = richScene();
    const a = addLayer(s, "Voice");
    a.hasVideo = false;
    const tr = a.transform("Position") as Rec;
    Object.defineProperty(tr, "staticValue", { get: () => [960, 540, 0], set: () => { throw new Error("the property or a parent property is hidden"); } });
    const vid = addLayer(s, "Video");
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1080, height: 1920 } }, expect: GUARD });
    expect(out.resize.layers_skipped).toEqual([expect.objectContaining({ name: "Voice", reason: expect.stringMatching(/audio-only/) })]);
    expect(posOf(vid).staticValue).toEqual([540, 960, 0]);
  });

  it("runs the user's guide steps before the resize and leaves guides they touched alone", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 100 }, { orientationType: 1, positionType: 0, position: 200 });
    const out = s.A.compsettingsApply({
      comp_id: s.comp.id,
      settings: { size: { width: 1080, height: 1080 } },
      guides: [{ action: "remove", index: 0 }, { action: "set", index: 0, position: 777 }, { action: "add", orientation: "vertical", position: 40 }],
      expect: GUARD,
    });
    expect(out.changed).toEqual(["guides", "size"]);
    // 100 removed; 200 became index 0 and was set by the user (new size, untouched); the add is untouched too.
    expect(s.guides.map((g) => g.position)).toEqual([777, 40]);
    expect(out.guide_shifts).toEqual([]);
  });

  it("a guide failure leaves the comp size alone", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 100 });
    (s.comp as Rec).setGuide = () => { throw new Error("guide rejected"); };
    expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1080, height: 1920 } }, guides: [{ action: "set", index: 0, position: 5 }], expect: GUARD })).toThrow();
    expect(s.comp.width).toBe(1920);
  });

  it("puts new guides in the new size and agrees with the mismatch logic", () => {
    const s = richScene();
    addLayer(s, "A");
    s.guides.push({ orientationType: 1, positionType: 0, position: 100 });
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    const settings = { size: { width: 1080, height: 1920, anchor: "center" } };
    const guides = [{ action: "add", orientation: "horizontal", position: 960 }];
    const args = { comp_id: s.comp.id, settings, guides, expect: expectArg } as any;
    const before = json(s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true }));
    const written = json(s.A.compsettingsApply({ comp_id: s.comp.id, settings, guides, expect: GUARD }));
    const after = json(s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true }));
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
    expect(after.guides.map((g: Rec) => g.position)).toEqual([-320, 960]);
  });

  it("refuses bad sizes and unreachable separated dimensions before the undo group", () => {
    const s = richScene();
    const run = (size: object) => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size }, expect: GUARD });
    expect(() => run({ width: 3, height: 100 })).toThrow(/4\.\.30000/);
    expect(() => run({ width: 100.5, height: 100 })).toThrow(/integers/);
    expect(() => run({ width: 100, height: 100, anchor: "middle" })).toThrow(/anchor must be one of/);
    const a = addLayer(s, "Sep");
    posOf(a).dimensionsSeparated = true;
    expect(() => run({ width: 100, height: 100 })).toThrow(/separated Position/);
    expect(s.undo.begun).toBe(0);
    expect(s.comp.width).toBe(1920);
  });
});

describe("compsettings.jsx: name, aspect, rate, drop frame", () => {
  it("renames and sets the pixel aspect", () => {
    const s = richScene();
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { name: "Hero", pixel_aspect: 1.5 }, expect: GUARD });
    expect(s.comp.name).toBe("Hero");
    expect(s.comp.pixelAspect).toBe(1.5);
    expect(out.changed).toEqual(["name", "pixel_aspect"]);
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    expect(r).toMatchObject({ name: "Hero", pixel_aspect: 1.5, drop_frame: false });
  });

  it("counts keys that fall between frames at the new rate without moving them", () => {
    const s = richScene();
    const a = addLayer(s, "A");
    posOf(a).setValueAtTime(0.04, [1, 1, 0]);
    posOf(a).setValueAtTime(1, [2, 2, 0]);
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { frame_rate: 30 }, expect: GUARD });
    expect(s.comp.frameRate).toBe(30);
    expect(out.keys_off_frame.count).toBe(1);
    expect(out.keys_off_frame.samples[0]).toMatchObject({ time: 0.04 });
    expect(posOf(a).keys.map((k: Rec) => k.time)).toEqual([0.04, 1]);
  });

  it("accepts drop frame at 29.97 (also set in the same call) and refuses it elsewhere", () => {
    const s = richScene();
    expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { drop_frame: true }, expect: GUARD })).toThrow(/29\.97 and 59\.94/);
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { frame_rate: 29.97, drop_frame: true }, expect: GUARD });
    expect(s.comp.dropFrame).toBe(true);
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { drop_frame: false }, expect: GUARD });
    expect(s.comp.dropFrame).toBe(false);
    expect(s.undo.begun).toBe(2);
  });

  it("refuses bad values before the undo group", () => {
    const s = richScene();
    const bad = (settings: object, re: RegExp) => expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings, expect: GUARD })).toThrow(re);
    bad({ name: "" }, /1\.\.255/);
    bad({ pixel_aspect: 0 }, /0\.01\.\.100/);
    bad({ frame_rate: 120 }, /1\.\.99/);
    bad({ drop_frame: "x" }, /true or false/);
    expect(s.undo.begun).toBe(0);
  });

  it("returns no_op with no undo group when everything asked for is already set", () => {
    const s = richScene();
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { name: "Main", frame_rate: 25, pixel_aspect: 1, drop_frame: false, size: { width: 1920, height: 1080 } }, expect: GUARD });
    expect(out.no_op).toBe(true);
    expect(out.changed).toEqual([]);
    expect(s.undo.begun).toBe(0);
  });

  it("refuses when the build lacks drop frame", () => {
    const s = richScene();
    delete s.comp.dropFrame;
    expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { drop_frame: false }, expect: GUARD })).toThrow(/not available/);
  });
});

describe("compsettings.jsx: duration and extend layers", () => {
  function footage(s: ReturnType<typeof richScene>, name: string, dur: number, still = false) {
    const item = s.project.addFootage(name, 100, 100, Object.assign(new FileSource(), { isStill: still })) as Rec;
    item.duration = dur;
    return s.comp.layers.add(item) as Rec;
  }

  it("extends layers that ran to the old end and skips footage that ends sooner", () => {
    const s = richScene();
    const solid = addLayer(s, "Solid");
    const clip = footage(s, "clip.mov", 10);
    const still = footage(s, "still.png", 0, true);
    const remap = footage(s, "remap.mov", 10);
    remap.timeRemapEnabled = true;
    const mid = addLayer(s, "Mid");
    mid.outPoint = 6;
    const locked = addLayer(s, "Locked");
    locked.locked = true;
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { duration: { seconds: 15 } }, expect: GUARD });
    expect(s.comp.duration).toBe(15);
    expect(solid.outPoint).toBe(15);
    expect(still.outPoint).toBe(15);
    expect(remap.outPoint).toBe(15);
    expect(locked.outPoint).toBe(15);
    expect(locked.locked).toBe(true);
    expect(clip.outPoint).toBe(10);
    expect(mid.outPoint).toBe(6);
    expect(out.duration_change).toMatchObject({ from: 10, to: 15, extended_count: 4, skipped_count: 1 });
    expect(out.duration_change.skipped[0]).toMatchObject({ name: "clip.mov", available_until: 10 });
    expect(s.undo.begun).toBe(1);
  });

  it("leaves layers alone with extend_layers false, and takes frames at the comp's rate", () => {
    const s = richScene();
    const a = addLayer(s, "A");
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { duration: { frames: 500, extend_layers: false } }, expect: GUARD });
    expect(s.comp.duration).toBe(20);
    expect(a.outPoint).toBe(10);
    expect(out.duration_change.extended_count).toBe(0);
  });

  it("uses a rate set in the same call for frames", () => {
    const s = richScene();
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { frame_rate: 50, duration: { frames: 500 } }, expect: GUARD });
    expect(s.comp.frameRate).toBe(50);
    expect(s.comp.duration).toBe(10);
  });

  it("shortening does not touch layers, and a work area is judged against the new length", () => {
    const s = richScene();
    const a = addLayer(s, "A");
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { duration: { seconds: 4 } }, expect: GUARD });
    expect(s.comp.duration).toBe(4);
    expect(a.outPoint).toBe(10);
    expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { work_area: { start: 0, duration: 6 } }, expect: GUARD })).toThrow(/past the comp's length of 4s/);
    expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { duration: { seconds: 20 }, work_area: { start: 5, duration: 10 } }, expect: GUARD })).not.toThrow();
    expect(s.comp.workAreaStart).toBe(5);
  });

  it("refuses bad lengths and agrees with the receipt check", () => {
    const s = richScene();
    const bad = (duration: object, re: RegExp) => expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { duration }, expect: GUARD })).toThrow(re);
    bad({}, /seconds or frames/);
    bad({ seconds: 4, frames: 100 }, /not both/);
    bad({ seconds: 10801 }, /10800/);
    bad({ seconds: 0.001 }, /shorter than one frame/);
    bad({ frames: 0 }, /whole number/);
    bad({ seconds: 5, extend_layers: "yes" }, /true or false/);
    expect(s.undo.begun).toBe(0);
    addLayer(s, "A");
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    const settings = { duration: { seconds: 14 } };
    const args = { comp_id: s.comp.id, settings, expect: expectArg } as any;
    const before = json(s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true }));
    const written = json(s.A.compsettingsApply({ comp_id: s.comp.id, settings, expect: GUARD }));
    const after = json(s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true }));
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
  });
});

/** AE derives a layer's in and out points from its start time; the fake keeps them as plain fields. */
function linkTiming(l: Rec) {
  let inOff = l.inPoint - l.startTime;
  let outOff = l.outPoint - l.startTime;
  Object.defineProperty(l, "inPoint", { get: () => l.startTime + inOff, set: (v: number) => { inOff = v - l.startTime; }, configurable: true });
  Object.defineProperty(l, "outPoint", { get: () => l.startTime + outOff, set: (v: number) => { outOff = v - l.startTime; }, configurable: true });
}

describe("compsettings.jsx: trim to work area", () => {
  function trimScene() {
    const s = richScene();
    s.comp.workAreaDuration = 4;
    s.comp.workAreaStart = 6;
    s.comp.displayStartTime = 1;
    const a = addLayer(s, "A");
    const locked = addLayer(s, "Locked");
    locked.locked = true;
    linkTiming(a);
    linkTiming(locked);
    posOf(a).setValueAtTime(7, [1, 1, 0]);
    const mp = s.comp.markerProperty as Rec;
    mp.setValueAtTime(1, { comment: "early" });
    mp.setValueAtTime(7, { comment: "inside" });
    mp.setValueAtTime(9.5, { comment: "late" });
    mp.setValueAtTime(12, { comment: "past" });
    return { s, a, locked, mp };
  }

  it("shifts every layer (locked ones too), the markers, and keeps the timecode", () => {
    const { s, a, locked, mp } = trimScene();
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { trim_to_work_area: true }, expect: GUARD });
    expect(s.comp.duration).toBe(4);
    expect(s.comp.workAreaStart).toBe(0);
    expect(s.comp.workAreaDuration).toBe(4);
    expect(s.comp.displayStartTime).toBe(7);
    expect(a.startTime).toBe(-6);
    expect(locked.startTime).toBe(-6);
    expect(locked.locked).toBe(true);
    expect(mp.keys.map((k: Rec) => k.time)).toEqual([1, 3.5]);
    expect(mp.keys.map((k: Rec) => k.value.comment)).toEqual(["inside", "late"]);
    expect(out.trim).toMatchObject({ shifted_by: 6, new_duration: 4, layers_shifted: 2, markers_kept: 2, markers_dropped: 2, display_start_time: 7 });
    expect(out.changed).toEqual(["trim_to_work_area"]);
    expect(s.undo).toMatchObject({ begun: 1, ended: 1 });
  });

  it("agrees with the receipt check end to end", () => {
    const { s } = trimScene();
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    const settings = { trim_to_work_area: true };
    const args = { comp_id: s.comp.id, settings, expect: expectArg } as any;
    const before = json(s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true }));
    const written = json(s.A.compsettingsApply({ comp_id: s.comp.id, settings, expect: GUARD }));
    const after = json(s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true }));
    expect(compSettingsMismatches(args, before, after, written)).toEqual([]);
    expect(after.layer_state.map((l: Rec) => l.start)).toEqual([-6, -6]);
  });

  it("does nothing when the area covers the comp, and refuses combinations", () => {
    const { s } = trimScene();
    s.A.compsettingsApply({ comp_id: s.comp.id, settings: { trim_to_work_area: true }, expect: GUARD });
    const again = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { trim_to_work_area: true }, expect: GUARD });
    expect(again.no_op).toBe(true);
    expect(again.notes[0]).toMatch(/already covers/);
    const t = trimScene();
    expect(() => t.s.A.compsettingsApply({ comp_id: t.s.comp.id, settings: { trim_to_work_area: true, duration: { seconds: 3 } }, expect: GUARD })).toThrow(/can't be combined/);
    expect(() => t.s.A.compsettingsApply({ comp_id: t.s.comp.id, settings: { trim_to_work_area: false }, expect: GUARD })).toThrow(/must be true/);
    expect(t.s.undo.begun).toBe(0);
  });

  it("refuses a trim whose timecode would pass AE's limit", () => {
    const { s } = trimScene();
    s.comp.displayStartTime = 86338;
    expect(() => s.A.compsettingsApply({ comp_id: s.comp.id, settings: { trim_to_work_area: true }, expect: GUARD })).toThrow(/86339/);
    expect(s.undo.begun).toBe(0);
  });
});

describe("compsettings.jsx: guide words, enums and 26.5 options", () => {
  it("reads orientation and position type as words, with the legacy meaning when AE has no enum", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 300 }, { orientationType: 0, positionType: 1, position: 25 });
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    expect(r.guides[0]).toMatchObject({ orientation: "vertical", position_kind: "pixel", orientation_type: 1, position_type: 0 });
    expect(r.guides[1]).toMatchObject({ orientation: "horizontal", position_kind: "percentage" });
  });

  it("maps through the enum constants when they exist, so renumbered integers read the same", () => {
    const s = richScene();
    s.G.GuideOrientationType = { HORIZONTAL: 7, VERTICAL: 3 };
    s.G.GuidePositionType = { PIXEL: 9, PERCENTAGE: 4 };
    s.guides.push({ orientationType: 3, positionType: 9, position: 300 }, { orientationType: 7, positionType: 4, position: 25 }, { orientationType: 1, positionType: 0, position: 1 });
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    expect(r.guides[0]).toMatchObject({ orientation: "vertical", position_kind: "pixel" });
    expect(r.guides[1]).toMatchObject({ orientation: "horizontal", position_kind: "percentage" });
    // Neither integer is a member of the enum: no word, only the raw numbers.
    expect(r.guides[2].orientation).toBeUndefined();
    expect(r.guides[2].orientation_type).toBe(1);
  });

  it("prefers getGuideAsObject when the build has it", () => {
    const s = richScene();
    s.guides.push({ orientationType: 1, positionType: 0, position: 300 });
    s.comp.getGuideAsObject = (i: number) => ({ orientation: 0, positionType: 0, position: 11 + i, pinned: true, color: [1, 0, 0] });
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    expect(r.guides[0]).toMatchObject({ orientation: "horizontal", position: 11, pinned: true, color: [1, 0, 0] });
  });

  function scene265() {
    const s = richScene({ guideApi: "none", version: "26.5.0x12" });
    const written: Rec[] = [];
    const list: Rec[] = [];
    Object.defineProperty(s.comp, "guides", { get: () => list.map((g) => ({ ...g })), configurable: true });
    s.G.GuideOptions = class {};
    s.G.GuideOrientationType = { HORIZONTAL: 11, VERTICAL: 12 };
    s.G.GuidePositionType = { PIXEL: 21, PERCENTAGE: 22 };
    s.comp.addGuide = (o: Rec) => {
      if (typeof o !== "object") throw new Error("options only");
      written.push({ op: "add", ...o });
      list.push({ orientationType: o.orientation, positionType: o.positionType ?? 21, position: o.position, color: o.color ?? [0, 1, 0], pinned: o.pinned === true });
      return list.length - 1;
    };
    s.comp.setGuide = (i: number, o: Rec) => {
      if (typeof o !== "object") throw new Error("options only");
      written.push({ op: "set", index: i, ...o });
      Object.assign(list[i], { position: o.position });
      if (o.positionType !== undefined) list[i].positionType = o.positionType;
      if (o.color !== undefined) list[i].color = o.color;
      if (o.pinned !== undefined) list[i].pinned = o.pinned;
    };
    s.comp.removeGuide = (i: number) => list.splice(i, 1);
    return { ...s, written, list };
  }

  it("writes a pinned guide the user added or set again after the resize", () => {
    const s = scene265();
    s.list.push({ orientationType: 12, positionType: 21, position: 100, color: [0, 1, 0], pinned: false });
    s.list.push({ orientationType: 12, positionType: 21, position: 200, color: [0, 1, 0], pinned: false });
    const out = s.A.compsettingsApply({
      comp_id: s.comp.id,
      settings: { size: { width: 1080, height: 1920 } },
      guides: [{ action: "set", index: 0, position: 50, pinned: true }, { action: "add", orientation: "vertical", position: 900, pinned: true }],
      expect: GUARD,
    });
    // Index 1 is untouched and unpinned (shifted by dx); 0 and 2 are the user's pinned guides, written again after the resize.
    expect(out.guide_shifts.map((x: Rec) => [x.index, x.position])).toEqual([[0, 50], [1, -220], [2, 900]]);
    expect(out.guide_shifts[0].keep).toMatchObject({ pinned: true, orientation: 12 });
    expect(s.list.map((g) => g.position)).toEqual([50, -220, 900]);
  });

  it("writes a pinned guide again after a resize whose anchor leaves the delta at zero", () => {
    const s = scene265();
    s.list.push({ orientationType: 12, positionType: 21, position: 100, color: [0, 1, 0], pinned: false });
    s.list.push({ orientationType: 12, positionType: 21, position: 200, color: [0, 1, 0], pinned: false });
    const out = s.A.compsettingsApply({
      comp_id: s.comp.id,
      settings: { size: { width: 1080, height: 1920, anchor: "top_left" } },
      guides: [{ action: "set", index: 0, position: 50, pinned: true }, { action: "add", orientation: "vertical", position: 900, pinned: true }],
      expect: GUARD,
    });
    expect(out.resize.delta.map((x: number) => x + 0)).toEqual([0, 0]);
    // Index 1 is untouched and unpinned: the zero delta leaves it alone. 0 and 2 are the user's pinned guides, written again.
    expect(out.guide_shifts.map((x: Rec) => [x.index, x.position])).toEqual([[0, 50], [2, 900]]);
    expect(s.list.map((g) => g.position)).toEqual([50, 200, 900]);
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    const guides = [{ action: "set", index: 0, position: 50, pinned: true }, { action: "add", orientation: "vertical", position: 900, pinned: true }];
    const settings = { size: { width: 1080, height: 1920, anchor: "top_left" } };
    const after = json(r);
    expect(compSettingsMismatches({ comp_id: s.comp.id, settings, guides, expect: expectArg } as any, info({ width: 1920, height: 1080 }), { ...after, width: 1080, height: 1920 }, json(out)).filter((m) => m.path.indexOf("guides[") === 0 && /position$/.test(m.path))).toEqual([]);
  });

  it("writes colour, pinned and a percentage position with a GuideOptions object on 26.5", () => {
    const s = scene265();
    const guides = [
      { action: "add", orientation: "vertical", position: 25, position_type: "percentage", color: [1, 0.5, 0], pinned: true },
      { action: "set", index: 0, position: 30, color: [0, 0, 1] },
    ];
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, guides, expect: GUARD });
    expect(out.guide_api).toBe("options");
    expect(s.written[0]).toMatchObject({ op: "add", orientation: 12, position: 25, positionType: 22, color: [1, 0.5, 0], pinned: true });
    expect(s.written[1]).toMatchObject({ op: "set", index: 0, position: 30, color: [0, 0, 1] });
    // The fields the set leaves out are given as they are, so the build can't default them.
    expect(s.written[1].orientation).toBe(12);
    expect(s.written[1].positionType).toBe(22);
    expect(s.written[1].pinned).toBe(true);
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    expect(r.guides[0]).toMatchObject({ orientation: "vertical", position_kind: "percentage", position: 30, color: [0, 0, 1], pinned: true });
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    expect(compSettingsMismatches({ comp_id: s.comp.id, guides, expect: expectArg } as any, info(), json(r), json(out))).toEqual([]);
  });

  it("keeps a guide's direction and position type when only its colour changes on 26.5", () => {
    const s = scene265();
    s.list.push({ orientationType: 12, positionType: 22, position: 40, color: [0, 1, 0], pinned: true });
    s.A.compsettingsApply({ comp_id: s.comp.id, guides: [{ action: "set", index: 0, position: 45, color: [1, 0, 0] }], expect: GUARD });
    expect(s.written[0]).toMatchObject({ op: "set", orientation: 12, positionType: 22, pinned: true, color: [1, 0, 0], position: 45 });
  });

  it("refuses colour, pinned and percentage before AE 26.5, and when the classes are missing", () => {
    const s = richScene();
    const run = (op: object) => s.A.compsettingsApply({ comp_id: s.comp.id, guides: [{ action: "add", orientation: "vertical", position: 10, ...op }], expect: GUARD });
    expect(() => run({ color: [1, 0, 0] })).toThrow(/26\.5 or later \(this is 26\.2\.1\)/);
    expect(() => run({ pinned: true })).toThrow(/26\.5 or later/);
    expect(() => run({ position_type: "percentage" })).toThrow(/26\.5 or later/);
    const n = scene265();
    delete n.G.GuideOptions;
    expect(() => n.A.compsettingsApply({ comp_id: n.comp.id, guides: [{ action: "add", orientation: "vertical", position: 1, pinned: true }], expect: GUARD })).toThrow(/no GuideOptions/);
    const m = scene265();
    delete m.G.GuidePositionType;
    expect(() => m.A.compsettingsApply({ comp_id: m.comp.id, guides: [{ action: "add", orientation: "vertical", position: 1, position_type: "percentage" }], expect: GUARD })).toThrow(/no GuidePositionType/);
    expect(() => m.A.compsettingsApply({ comp_id: m.comp.id, guides: [{ action: "add", orientation: "vertical", position: 1, color: [1, 0, 9] }], expect: GUARD })).toThrow(/0\.\.1/);
    expect(s.undo.begun).toBe(0);
    expect(m.undo.begun).toBe(0);
  });
});

describe("compsettings.jsx: review fixes", () => {
  it("reads guide words through a bare enum identifier", () => {
    const s = richScene({ guideApi: "none", version: "26.5.0x12" });
    // Reachable as a bare identifier only, not as a member of the global object.
    s.G.GuideOrientationType = { HORIZONTAL: 11, VERTICAL: 12 };
    s.comp.guides = [{ orientationType: 12, positionType: 0, position: 5 }];
    const r = s.A.compsettingsRead({ comp_id: s.comp.id });
    expect(r.guides[0].orientation).toBe("vertical");
  });

  it("does not flag the start frame when the frame rate changes on a comp that starts later", () => {
    const base = info({ fps: 25, display_start_time: 10, display_start_frame: 250 });
    const after = info({ fps: 30, frame_duration: 1 / 30, display_start_time: 10, display_start_frame: 300 });
    const args = { comp_id: 1, settings: { frame_rate: 30 }, expect: expectArg } as any;
    expect(compSettingsMismatches(args, base, after, {})).toEqual([]);
  });

  it("checks that a trim kept the displayed timecode", () => {
    const base = info();
    const after = info({ duration: 4, display_start_time: 1, work_area: { start: 0, duration: 4 } });
    const args = { comp_id: 1, settings: { trim_to_work_area: true }, expect: expectArg } as any;
    const written = { trim: { new_duration: 4, shifted_by: 6, display_start_time: 7 } };
    expect(compSettingsMismatches(args, base, after, written).map((x) => x.path)).toContain("settings.trim_to_work_area.display_start_time");
  });

  it("samples an expression-driven Position before the expression and leaves such layers out of the check", () => {
    const s = richScene();
    const a = addLayer(s, "Wig");
    posOf(a).expressionEnabled = true;
    const seen: boolean[] = [];
    posOf(a).valueAtTime = (_t: number, pre: boolean) => {
      seen.push(pre);
      return [960, 540, 0];
    };
    const r = s.A.compsettingsRead({ comp_id: s.comp.id, layer_state: true });
    expect(seen).toContain(true);
    expect(r.layer_state[0].position).toEqual([960, 540]);
    const before = JSON.parse(JSON.stringify(r));
    const after = JSON.parse(JSON.stringify({ ...r, width: 1000, height: 1000, layer_state: [{ ...r.layer_state[0], position: [500, 500] }] }));
    const written = { resize: { layers_skipped: [{ id: a.id }] }, moved_layers: [] };
    const args = { comp_id: s.comp.id, settings: { size: { width: 1000, height: 1000 } }, expect: expectArg } as any;
    expect(compSettingsMismatches(args, before, after, written).filter((x) => x.path.startsWith("layers["))).toEqual([]);
  });

  it("skips ambient lights and leaves a one-node camera's point of interest alone", () => {
    const s = richScene();
    s.G.AutoOrientType = { CAMERA_OR_POINT_OF_INTEREST: 4210, NO_AUTO_ORIENT: 4212 };
    const amb = s.comp.layers.addLight("Amb", [0, 0]) as Rec;
    amb.matchName = "ADBE Light Layer";
    amb.lightType = 4415;
    amb.transform("Position").staticValue = [960, 540, 0];
    const cam = s.comp.layers.addCamera("One", [0, 0]) as Rec;
    cam.matchName = "ADBE Camera Layer";
    cam.autoOrient = 4212;
    cam.transform("Position").staticValue = [960, 540, -1000];
    cam.transform("Anchor Point").staticValue = [960, 540, 0];
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { size: { width: 1920, height: 1280 } }, expect: GUARD });
    expect(out.resize.layers_skipped).toEqual([expect.objectContaining({ name: "Amb", reason: expect.stringMatching(/ambient/) })]);
    expect(amb.transform("Position").staticValue).toEqual([960, 540, 0]);
    expect(cam.transform("Position").staticValue).toEqual([960, 640, -1000]);
    expect(cam.transform("Anchor Point").staticValue).toEqual([960, 540, 0]);
  });

  it("fits the work area into a shorter comp before shortening it", () => {
    const s = richScene();
    s.comp.workAreaDuration = 4;
    s.comp.workAreaStart = 6;
    const out = s.A.compsettingsApply({ comp_id: s.comp.id, settings: { duration: { seconds: 5 } }, expect: GUARD });
    expect(s.comp.duration).toBe(5);
    expect(s.comp.workAreaStart + s.comp.workAreaDuration).toBeLessThanOrEqual(5 + 1e-9);
    expect(out.duration_change.work_area_clamped).toMatchObject({ from: { start: 6, duration: 4 } });
  });
});
