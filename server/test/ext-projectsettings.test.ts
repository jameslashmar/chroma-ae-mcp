import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  AeProjectSettingsSchema,
  ProjectSettingsValuesSchema,
  newExpressionErrors,
  projectSettingsMismatches,
  projectsettingsTools,
  sideEffects,
  type ProjectSettingsInfo,
} from "../src/tools/ext/projectsettings.js";
import { FakeProject, GUARD, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = projectsettingsTools[0];
const expectArg = { project_path: "<unsaved>" };

/** A PanelHost whose AE answers from a script of results, recording each call and its script. */
function fakeAe(results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; script: string }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-projsettings-q-"));
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

const info = (extra: Partial<ProjectSettingsInfo> = {}): ProjectSettingsInfo => ({
  bits_per_channel: 8,
  working_space: "",
  working_gamma: 2.2,
  linear_blending: false,
  expression_engine: "extendscript",
  time_display_type: "timecode",
  frames_count_type: "start_0",
  display_start_frame: 0,
  gpu_accel_type: "software",
  list_color_profiles: ["sRGB IEC61966-2.1", "Rec.709 Gamma 2.4"],
  available_gpu_types: ["software", "cuda"],
  probed: { found: {}, not_found: ["ocioConfigFile"] },
  unreadable: [],
  ...extra,
});

describe("ae_project_settings schema", () => {
  it("reads with no arguments and needs expect.project_path to set", () => {
    expect(AeProjectSettingsSchema.safeParse({}).success).toBe(true);
    expect(AeProjectSettingsSchema.safeParse({ set: { bits_per_channel: 16 } }).success).toBe(false);
    expect(AeProjectSettingsSchema.safeParse({ set: { bits_per_channel: 16 }, expect: expectArg }).success).toBe(true);
  });

  it("keeps the argument names ae_preflight points its fixes at", () => {
    const ok = AeProjectSettingsSchema.safeParse({
      set: { bits_per_channel: 32, working_space: "sRGB IEC61966-2.1", expression_engine: "javascript-1.0" },
      expect: expectArg,
    });
    expect(ok.success).toBe(true);
  });

  it("refuses bad values before AE is asked", () => {
    const bad = (set: unknown) => ProjectSettingsValuesSchema.safeParse(set).success;
    expect(bad({ bits_per_channel: 24 })).toBe(false);
    expect(bad({ working_gamma: 1.8 })).toBe(false);
    expect(bad({ working_gamma: 2.4, working_space: "" })).toBe(true);
    expect(bad({ working_gamma: 2.4, working_space: "sRGB IEC61966-2.1" })).toBe(false);
    expect(bad({ expression_engine: "javascript" })).toBe(false);
    expect(bad({})).toBe(false);
    expect(bad({ no_such_setting: true })).toBe(false);
    expect(bad({ frames_count_type: "timecode_conversion", display_start_frame: 5 })).toBe(false);
    expect(bad({ frames_count_type: "FC_TIMECODE_CONVERSION", display_start_frame: 1 })).toBe(false);
    expect(bad({ frames_count_type: "start_1", display_start_frame: 1 })).toBe(true);
    expect(bad({ frames_count_type: "start_1", display_start_frame: 0 })).toBe(false);
    expect(bad({ frames_count_type: "start_0", display_start_frame: 1 })).toBe(false);
    expect(bad({ display_start_frame: 5 })).toBe(false);
  });

  it("check_comps goes with an expression_engine change only", () => {
    expect(AeProjectSettingsSchema.safeParse({ check_comps: [1] }).success).toBe(false);
    expect(AeProjectSettingsSchema.safeParse({ set: { bits_per_channel: 16 }, expect: expectArg, check_comps: [1] }).success).toBe(false);
    expect(AeProjectSettingsSchema.safeParse({ set: { expression_engine: "javascript-1.0" }, expect: expectArg, check_comps: [1] }).success).toBe(true);
  });

  it("describes itself as a guarded write", () => {
    expect(tool.description).toContain("checkpointing first");
    expect(tool.description).toContain("expect");
  });
});

describe("ae_project_settings read", () => {
  it("calls the read host function only", async () => {
    const { ctx, calls } = fakeAe({ projectsettingsRead: [info()] });
    const out = await tool.handler(AeProjectSettingsSchema.parse({}), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["projectsettingsRead"]);
    expect(out).toMatchObject({ ok: true, bits_per_channel: 8, working_space: "", gpu_accel_type: "software" });
    expect(out.list_color_profiles).toHaveLength(2);
  });
});

describe("ae_project_settings guarded write", () => {
  it("guards, reads, writes and reads back in a separate call", async () => {
    const { ctx, calls } = fakeAe({
      projectsettingsRead: [info(), info({ bits_per_channel: 16 })],
      projectsettingsApply: [{ no_op: false, changed: [{ key: "bits_per_channel", from: 8, to: 16 }], unchanged: [], failed: [], display_start_frame_reset: false, expression_engine_changed: false }],
    });
    const out = await tool.handler(AeProjectSettingsSchema.parse({ set: { bits_per_channel: 16 }, expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual(["checkGuard", "projectsettingsRead", "projectsettingsApply", "projectsettingsRead"]);
    expect(calls[2].script).toContain('"expect"');
    expect(out.receipt.matches).toBe(true);
    expect(out.changed).toEqual([{ key: "bits_per_channel", from: 8, to: 16 }]);
    expect(out.settings.bits_per_channel).toBe(16);
    expect(out.expression_check).toBeUndefined();
  });

  it("flags a setting that did not stick in the receipt, without throwing", async () => {
    const { ctx } = fakeAe({
      projectsettingsRead: [info(), info()],
      projectsettingsApply: [{ no_op: false, changed: [{ key: "bits_per_channel", from: 8, to: 16 }], unchanged: [], failed: [] }],
    });
    const out = await tool.handler(AeProjectSettingsSchema.parse({ set: { bits_per_channel: 16 }, expect: expectArg }), ctx);
    expect(out.receipt.matches).toBe(false);
    expect(JSON.stringify(out.receipt)).toContain("set.bits_per_channel");
  });

  it("reports a no-op when every value was already set", async () => {
    const { ctx } = fakeAe({
      projectsettingsRead: [info(), info()],
      projectsettingsApply: [{ no_op: true, changed: [], unchanged: ["bits_per_channel"], failed: [] }],
    });
    const out = await tool.handler(AeProjectSettingsSchema.parse({ set: { bits_per_channel: 8 }, expect: expectArg }), ctx);
    expect(out.no_op).toBe(true);
    expect(out.notes[0]).toContain("already set");
  });

  it("notes the start-frame reset after timecode_conversion and the GPU re-initialisation", async () => {
    const { ctx } = fakeAe({
      projectsettingsRead: [info({ display_start_frame: 1 }), info({ frames_count_type: "timecode_conversion", display_start_frame: 0, gpu_accel_type: "cuda" })],
      projectsettingsApply: [
        {
          no_op: false,
          changed: [
            { key: "frames_count_type", from: "start_0", to: "timecode_conversion" },
            { key: "gpu_accel_type", from: "software", to: "cuda" },
          ],
          unchanged: [],
          failed: [],
          display_start_frame_reset: true,
        },
      ],
    });
    const out = await tool.handler(
      AeProjectSettingsSchema.parse({ set: { frames_count_type: "timecode_conversion", gpu_accel_type: "cuda" }, expect: expectArg }),
      ctx
    );
    expect(out.display_start_frame_reset).toBe(true);
    expect(out.notes.join(" ")).toContain("reset display_start_frame");
    expect(out.notes.join(" ")).toContain("re-initialise the GPU");
    expect(out.side_effects).toEqual([{ key: "display_start_frame", from: 1, to: 0 }]);
    expect(out.receipt.matches).toBe(true);
  });

  it("scans expressions after an engine switch and lists only new errors", async () => {
    const err = (id: number, msg: string) => ({ layer: { index: 1, id, name: "L" }, path: ["Transform", "Position"], expression: "x", error: msg });
    const { ctx, calls } = fakeAe({
      projectsettingsRead: [
        info({ comps: [{ id: 10, name: "Main" }, { id: 11, name: "Sub" }] }),
        info(),
        info({ expression_engine: "javascript-1.0" }),
      ],
      validateExpressions: [
        { comp_id: 10, comp_name: "Main", error_count: 1, results: [err(1, "old error")] },
        { comp_id: 11, comp_name: "Sub", error_count: 0, results: [] },
        { comp_id: 10, comp_name: "Main", error_count: 2, results: [err(1, "old error"), err(2, "new error")] },
        { comp_id: 11, comp_name: "Sub", error_count: 0, results: [] },
      ],
      projectsettingsApply: [{ no_op: false, changed: [{ key: "expression_engine", from: "extendscript", to: "javascript-1.0" }], unchanged: [], failed: [], expression_engine_changed: true }],
    });
    const out = await tool.handler(AeProjectSettingsSchema.parse({ set: { expression_engine: "javascript-1.0" }, expect: expectArg }), ctx);
    expect(calls.map((c) => c.fn)).toEqual([
      "checkGuard",
      "projectsettingsRead",
      "validateExpressions",
      "validateExpressions",
      "checkGuard",
      "projectsettingsRead",
      "projectsettingsApply",
      "projectsettingsRead",
      "validateExpressions",
      "validateExpressions",
    ]);
    expect(out.expression_check).toMatchObject({ comps_checked: 2, compared_with_before: true, new_error_count: 1 });
    expect(out.expression_check.new_error_comps[0].errors[0].error).toBe("new error");
  });

  it("does not throw when the post-write expression scan fails", async () => {
    const { ctx } = fakeAe({
      projectsettingsRead: [info({ comps: [{ id: 10, name: "Main" }] }), info(), info({ expression_engine: "javascript-1.0" })],
      validateExpressions: [{ comp_id: 10, results: [] }, new Error("boom")],
      projectsettingsApply: [{ no_op: false, changed: [{ key: "expression_engine", from: "extendscript", to: "javascript-1.0" }], unchanged: [], failed: [], expression_engine_changed: true }],
    });
    const out = await tool.handler(AeProjectSettingsSchema.parse({ set: { expression_engine: "javascript-1.0" }, expect: expectArg }), ctx);
    expect(out.applied).toBe(true);
    expect(out.expression_check).toMatchObject({ comps_checked: 0, new_error_count: 0 });
  });
});

describe("pure logic", () => {
  it("compares the read-back with the request, case-insensitively for enum names but not profiles", () => {
    const after = info({ working_space: "sRGB IEC61966-2.1", time_display_type: "frames" });
    expect(projectSettingsMismatches({ working_space: "sRGB IEC61966-2.1", time_display_type: "FRAMES" }, after, {})).toEqual([]);
    const tc = projectSettingsMismatches({ display_start_frame: 0 }, info({ display_start_frame: 0, frames_count_type: "timecode_conversion" }), {});
    expect(tc).toHaveLength(1);
    expect(projectSettingsMismatches({ display_start_frame: 0 }, info({ display_start_frame: 0, frames_count_type: "start_0" }), {})).toEqual([]);
    const m = projectSettingsMismatches({ working_space: "srgb iec61966-2.1" }, after, {});
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe("set.working_space");
  });

  it("turns a failed member into a mismatch and skips its read-back", () => {
    const m = projectSettingsMismatches({ bits_per_channel: 32 }, info(), { failed: [{ key: "bits_per_channel", message: "nope" }] });
    expect(m).toHaveLength(1);
    expect(m[0].message).toContain("nope");
  });

  it("reports unreadable read-backs", () => {
    const after = info();
    delete after.expression_engine;
    expect(projectSettingsMismatches({ expression_engine: "javascript-1.0" }, after, {})[0].message).toContain("could not be read back");
  });

  it("lists settings that moved though not asked", () => {
    expect(sideEffects({ bits_per_channel: 32 }, info(), info({ bits_per_channel: 32, linear_blending: true }))).toEqual([
      { key: "linear_blending", from: false, to: true },
    ]);
  });

  it("finds new expression errors only", () => {
    const e = (id: number, error: string) => ({ layer: { id }, path: ["P"], error });
    const out = newExpressionErrors([{ comp_id: 1, results: [e(1, "a")] }], [{ comp_id: 1, comp_name: "C", results: [e(1, "a"), e(2, "b")] }]);
    expect(out).toEqual([{ comp_id: 1, comp_name: "C", errors: [{ layer: { id: 2 }, path: ["P"], error: "b" }] }]);
  });
});

// ---------- the host functions under node:vm ----------

const CUDA = 7;
const METAL = 8;
const SOFT = 1;

function scene(opts: { throwOnWorkingSpace?: boolean; omit?: string[] } = {}) {
  const project: any = new FakeProject();
  const store: Record<string, unknown> = {
    bitsPerChannel: 8,
    workingSpace: "",
    workingGamma: 2.2,
    linearBlending: false,
    linearizeWorkingSpace: false,
    compensateForSceneReferredProfiles: false,
    expressionEngine: "extendscript",
    timeDisplayType: 0,
    framesCountType: 0,
    displayStartFrame: 0,
    framesUseFeetFrames: false,
    feetFramesFilmType: 0,
    footageTimecodeDisplayStartType: 0,
    transparencyGridThumbnails: false,
    gpuAccelType: SOFT,
  };
  const writes: Array<[string, unknown]> = [];
  for (const k of Object.keys(store)) {
    if (opts.omit?.includes(k)) continue;
    Object.defineProperty(project, k, {
      get: () => store[k],
      set: (v) => {
        if (k === "workingSpace" && opts.throwOnWorkingSpace) throw new Error("profile rejected");
        if (k === "workingGamma" && v !== 2.2 && v !== 2.4) throw new Error("bad gamma");
        writes.push([k, v]);
        store[k] = v;
        if (k === "framesCountType" && v === 2) store.displayStartFrame = 0;
        if (k === "displayStartFrame") store.framesCountType = v;
      },
      configurable: true,
    });
  }
  project.listColorProfiles = () => ["sRGB IEC61966-2.1", "Rec.709 Gamma 2.4"];
  const comp = project.addComp("Main", 640, 360, 3);
  project.addComp("Sub", 640, 360, 3);
  const host = loadHost(project, ["projectsettings.jsx"], { availableGPUAccelTypes: [SOFT, CUDA] });
  host.G.TimeDisplayType = { TIMECODE: 0, FRAMES: 1 };
  host.G.FramesCountType = { FC_START_0: 0, FC_START_1: 1, FC_TIMECODE_CONVERSION: 2 };
  host.G.FeetFramesFilmType = { MM16: 0, MM35: 1 };
  host.G.FootageTimecodeDisplayStartType = { FTCS_START_0: 0, FTCS_USE_SOURCE_MEDIA: 1 };
  host.G.GpuAccelType = { SOFTWARE: SOFT, CUDA, METAL };
  return { project, comp, store, writes, ...host };
}

describe("projectsettings.jsx read", () => {
  it("reads every setting, the enum names, the profiles and the GPU types without an undo group", () => {
    const { A, undo } = scene();
    const r = A.projectsettingsRead({});
    expect(r).toMatchObject({
      bits_per_channel: 8,
      working_space: "",
      working_gamma: 2.2,
      expression_engine: "extendscript",
      time_display_type: "timecode",
      frames_count_type: "start_0",
      footage_timecode_display_start_type: "start_0",
      feet_frames_film_type: "mm16",
      gpu_accel_type: "software",
    });
    expect(typeof r.project_path).toBe("string");
    expect(r.list_color_profiles).toEqual(["sRGB IEC61966-2.1", "Rec.709 Gamma 2.4"]);
    expect(r.available_gpu_types).toEqual(["software", "cuda"]);
    expect(r.unreadable).toEqual([]);
    expect(undo.begun).toBe(0);
  });

  it("probes undocumented colour members and reports found or not found", () => {
    const { A, project } = scene();
    project.ocioConfigFile = "C:/aces/config.ocio";
    const r = A.projectsettingsRead({});
    expect(r.probed.found.ocioConfigFile).toBe("C:/aces/config.ocio");
    expect(r.probed.not_found).toContain("acesConfig");
  });

  it("lists members this AE does not have instead of failing", () => {
    const { A } = scene({ omit: ["linearizeWorkingSpace", "expressionEngine"] });
    const r = A.projectsettingsRead({});
    expect(r.unreadable).toEqual(expect.arrayContaining(["linearize_working_space", "expression_engine"]));
    expect(r.bits_per_channel).toBe(8);
  });

  it("lists the comps on request", () => {
    const { A } = scene();
    expect(A.projectsettingsRead({ comps: true }).comps.map((c: any) => c.name)).toEqual(["Main", "Sub"]);
  });
});

describe("projectsettings.jsx apply", () => {
  it("sets several values in one undo group, enums by name", () => {
    const { A, undo, store } = scene();
    const out = A.projectsettingsApply({
      expect: GUARD,
      set: { bits_per_channel: 32, working_space: "sRGB IEC61966-2.1", time_display_type: "frames", gpu_accel_type: "cuda", expression_engine: "javascript-1.0" },
    });
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(out.no_op).toBe(false);
    expect(out.changed.map((c: any) => c.key)).toEqual(["working_space", "bits_per_channel", "expression_engine", "time_display_type", "gpu_accel_type"]);
    expect(out.expression_engine_changed).toBe(true);
    expect(out.failed).toEqual([]);
    expect(store).toMatchObject({ bitsPerChannel: 32, workingSpace: "sRGB IEC61966-2.1", timeDisplayType: 1, gpuAccelType: CUDA, expressionEngine: "javascript-1.0" });
    const reread = A.projectsettingsRead({});
    expect(reread).toMatchObject({ bits_per_channel: 32, time_display_type: "frames", gpu_accel_type: "cuda" });
  });

  it("moves the Frame Count menu off timecode_conversion when display_start_frame 0 is asked", () => {
    const { A, undo, store } = scene();
    store.framesCountType = 2;
    const out = A.projectsettingsApply({ expect: GUARD, set: { display_start_frame: 0 } });
    expect(out.no_op).toBe(false);
    expect(undo.begun).toBe(1);
    expect(store.framesCountType).toBe(0);
  });

  it("accepts a working_space that sits past the 500-entry list cap", () => {
    const { A, project, store } = scene();
    const many: string[] = [];
    for (let i = 0; i < 600; i++) many.push("Profile " + i);
    project.listColorProfiles = () => many;
    const out = A.projectsettingsApply({ expect: GUARD, set: { working_space: "Profile 550" } });
    expect(out.no_op).toBe(false);
    expect(store.workingSpace).toBe("Profile 550");
  });

  it("returns no_op without an undo group when nothing differs", () => {
    const { A, undo, writes } = scene();
    const out = A.projectsettingsApply({ expect: GUARD, set: { bits_per_channel: 8, working_gamma: 2.2, time_display_type: "TIMECODE" } });
    expect(out.no_op).toBe(true);
    expect(out.unchanged).toEqual(["working_gamma", "bits_per_channel", "time_display_type"]);
    expect(undo.begun).toBe(0);
    expect(writes).toEqual([]);
  });

  it("refuses a bad profile string, bad bit depth, bad gamma and gamma with a working space, before any undo group", () => {
    const { A, undo, writes } = scene();
    const fails = (set: unknown, text: string) => {
      expect(() => A.projectsettingsApply({ expect: GUARD, set })).toThrow(text);
    };
    fails({ working_space: "srgb iec61966-2.1" }, "exactly match");
    fails({ bits_per_channel: 24 }, "8, 16 or 32");
    fails({ working_gamma: 1.8 }, "2.2 or 2.4");
    fails({ working_gamma: 2.4, working_space: "sRGB IEC61966-2.1" }, "ignored once a working space is set");
    fails({ expression_engine: "v8" }, "extendscript");
    fails({ time_display_type: "nope" }, "timecode, frames");
    fails({ gpu_accel_type: "metal" }, "not available on this machine");
    fails({ frames_count_type: "timecode_conversion", display_start_frame: 1 }, "resets display_start_frame");
    fails({ frames_count_type: "start_1", display_start_frame: 0 }, "disagree");
    fails({ display_start_frame: 5 }, "0 or 1");
    fails({ frames_count_type: "FC_START_1" }, "must be one of");
    fails({ frames_count_type: "FC_TIMECODE_CONVERSION", display_start_frame: 1 }, "must be one of");
    fails({ unknown_key: 1 }, "Unknown setting");
    fails({}, "no settings");
    expect(undo.begun).toBe(0);
    expect(writes).toEqual([]);
  });

  it("refuses gamma while a working space is already set, and allows it after clearing in the same call", () => {
    const { A, store } = scene();
    store.workingSpace = "sRGB IEC61966-2.1";
    expect(() => A.projectsettingsApply({ expect: GUARD, set: { working_gamma: 2.4 } })).toThrow("ignored once a working space is set");
    const out = A.projectsettingsApply({ expect: GUARD, set: { working_space: "", working_gamma: 2.4 } });
    expect(out.changed.map((c: any) => c.key)).toEqual(["working_space", "working_gamma"]);
    expect(store.workingGamma).toBe(2.4);
  });

  it("refuses a member this AE version does not have, naming the version", () => {
    const { A, undo } = scene({ omit: ["linearizeWorkingSpace"] });
    expect(() => A.projectsettingsApply({ expect: GUARD, set: { linearize_working_space: true } })).toThrow("needs After Effects 16.0");
    expect(undo.begun).toBe(0);
  });

  it("checks the target guard first", () => {
    const { A, writes } = scene();
    expect(() => A.projectsettingsApply({ expect: { project_path: "C:/other.aep" }, set: { bits_per_channel: 16 } })).toThrow(/guard/i);
    expect(writes).toEqual([]);
  });

  it("reports the start-frame reset after timecode_conversion", () => {
    const { A, store } = scene();
    store.displayStartFrame = 1;
    const out = A.projectsettingsApply({ expect: GUARD, set: { frames_count_type: "timecode_conversion" } });
    expect(out.display_start_frame_reset).toBe(true);
    expect(A.projectsettingsRead({}).display_start_frame).toBe(0);
  });

  it("closes the undo group and reports a member AE refuses mid-write", () => {
    const { A, undo, store } = scene({ throwOnWorkingSpace: true });
    const out = A.projectsettingsApply({ expect: GUARD, set: { working_space: "Rec.709 Gamma 2.4", bits_per_channel: 16 } });
    expect(undo).toEqual({ begun: 1, ended: 1 });
    expect(out.failed).toEqual([{ key: "working_space", message: "profile rejected" }]);
    expect(out.changed.map((c: any) => c.key)).toEqual(["bits_per_channel"]);
    expect(store.bitsPerChannel).toBe(16);
  });
});
