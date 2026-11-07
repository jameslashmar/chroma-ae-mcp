import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { zodToJsonSchema } from "../src/schema.js";
import {
  AeAerenderCancelSchema,
  buildAerenderArgs,
  itemFrameRange,
  itemOutputs,
  rqStatusRefusal,
  selectRqItem,
  selectWholeQueue,
  type RqItemRead,
  AeAerenderStartSchema,
  AeAerenderStatusSchema,
  AerenderJobRegistry,
  MACOS_FALLBACK_AERENDER,
  WINDOWS_FALLBACK_AERENDER,
  createAerenderTools,
  parseAerenderProgress,
  resolveAerenderPath,
} from "../src/tools/ext/aerender.js";
import { AGENT_SAFETY_GUIDANCE } from "../src/tools/common.js";
import { resetResourceCache, resourceDeps } from "../src/system-resources.js";
import { footagePage, makeSequence, useOldFiles } from "./support/seq-fixtures.js";
import { seqscanDeps } from "../src/seqscan.js";

const NO_GATE = { cool_down_ms: 0, list_engines: () => [] };

class FakeChildProcess extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignal: string | number | undefined;
  unreffed = false;

  constructor(pid: number = 4242) {
    super();
    this.pid = pid;
  }

  kill(signal?: string | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }

  unref(): void {
    this.unreffed = true;
  }
}

describe("ext/aerender (background aerender jobs)", () => {
  const tmpDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-aerender-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("resolves aerender path next to AfterFX.exe on Windows, Windows fallback, and .app parent on macOS", () => {
    const winFromAfterFx = resolveAerenderPath({
      platform: "win32",
      afterFxPath:
        "D:\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe",
      existsSync: () => true,
    });
    expect(winFromAfterFx).toBe(
      "D:/Adobe/Adobe After Effects 2026/Support Files/aerender.exe"
    );

    const winFallback = resolveAerenderPath({
      platform: "win32",
      existsSync: () => false,
    });
    expect(winFallback).toBe(WINDOWS_FALLBACK_AERENDER);

    const macFromApp = resolveAerenderPath({
      platform: "darwin",
      afterFxPath:
        "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
      existsSync: () => true,
    });
    expect(macFromApp).toBe("/Applications/Adobe After Effects 2026/aerender");

    const macFallback = resolveAerenderPath({
      platform: "darwin",
      existsSync: () => false,
    });
    expect(macFallback).toBe(MACOS_FALLBACK_AERENDER);
  });

  it("validates schemas and converts to JSON Schema cleanly", () => {
    const startJson = zodToJsonSchema(AeAerenderStartSchema);
    expect(startJson.type).toBe("object");
    expect(startJson.properties).toHaveProperty("expect");
    expect(startJson.properties).toHaveProperty("comp_name");
    expect(startJson.properties).toHaveProperty("output_path");

    expect(
      AeAerenderStartSchema.safeParse({
        expect: { project_path: "C:/proj/demo.aep" },
        comp_name: "Main Comp",
        output_path: "C:/out/render.mov",
        start_frame: 10,
        end_frame: 5,
      }).success
    ).toBe(false);

    expect(AeAerenderStatusSchema.safeParse({ job_id: "job_1" }).success).toBe(
      true
    );
    expect(AeAerenderCancelSchema.safeParse({ job_id: "job_1" }).success).toBe(
      true
    );
  });

  it("parses PROGRESS lines for frame progress", () => {
    const sampleLog = [
      "PROGRESS:  10/27/2026 1:45:00 PM: Starting composition \"Main Comp\".",
      "PROGRESS:  Render Settings: Best Settings",
      "PROGRESS:  Output Module: Lossless",
      "PROGRESS:  0:00:00:00 (0): 0 Seconds",
      "PROGRESS:  0:00:00:01 (1): 1 Seconds",
      "PROGRESS:  0:00:00:02 (2): 0 Seconds",
      "PROGRESS:  0:00:00:03 (3): 1 Seconds",
      "PROGRESS:  0:00:00:04 (4): 1 Seconds",
    ].join("\n");

    const prog = parseAerenderProgress(sampleLog, {
      start_frame: 0,
      end_frame: 9,
      state: "running",
    });

    expect(prog.current_frame).toBe(4);
    expect(prog.frames_completed).toBe(5);
    expect(prog.total_frames).toBe(10);
    expect(prog.percent).toBe(50);
    expect(prog.last_progress_line).toContain("(4)");
  });

  it("refuses ae_aerender_start when the project is unsaved, mismatched, or dirty", async () => {
    const dir = makeTempDir();
    const registry = new AerenderJobRegistry(path.join(dir, "jobs.json"), NO_GATE);
    const tools = createAerenderTools({ registry });
    const startTool = tools.find((t) => t.name === "ae_aerender_start")!;
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));

    let statusResult: Record<string, unknown> = {
      aeVersion: "26.0x68",
      project_path: "<unsaved>",
      dirty: false,
    };

    const host = new PanelHost({
      evalScript: async () => ({
        ok: true,
        result: statusResult,
        durationMs: 2,
      }),
      queue,
      quarantine,
    });

    // 1. Unsaved project
    await expect(
      startTool.handler(
        {
          expect: { project_path: "C:/work/test.aep" },
          comp_name: "Main",
          output_path: path.join(dir, "out.mov"),
        },
        { bridge: host, queue, quarantine }
      )
    ).rejects.toThrow(BridgeError);

    // 2. Dirty project
    statusResult = {
      aeVersion: "26.0x68",
      project_path: "C:/work/test.aep",
      dirty: true,
    };
    try {
      await startTool.handler(
        {
          expect: { project_path: "C:/work/test.aep" },
          comp_name: "Main",
          output_path: path.join(dir, "out.mov"),
        },
        { bridge: host, queue, quarantine }
      );
      expect.unreachable("Should have refused dirty project");
    } catch (err) {
      const bErr = err as BridgeError;
      expect(bErr).toBeInstanceOf(BridgeError);
      expect(bErr.kind).toBe("guard");
      expect(bErr.message).toMatch(/dirty/i);
    }

    // 3. Mismatched project_path
    statusResult = {
      aeVersion: "26.0x68",
      project_path: "C:/work/other.aep",
      dirty: false,
    };
    await expect(
      startTool.handler(
        {
          expect: { project_path: "C:/work/test.aep" },
          comp_name: "Main",
          output_path: path.join(dir, "out.mov"),
        },
        { bridge: host, queue, quarantine }
      )
    ).rejects.toMatchObject({ kind: "guard" });
  });

  it("spawns aerender detached with windowsHide:true, mirrors job to JSON, tracks status, and cancels", async () => {
    const dir = makeTempDir();
    const jobsJsonPath = path.join(dir, "renders", "jobs.json");
    const registry = new AerenderJobRegistry(jobsJsonPath, NO_GATE);

    let spawnedCmd = "";
    let spawnedArgs: readonly string[] = [];
    let spawnedOpts: childProcess.SpawnOptions = {};
    const fakeChild = new FakeChildProcess(9876);

    const tools = createAerenderTools({
      registry,
      platform: "win32",
      afterFxPath:
        "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe",
      existsSync: () => true,
      spawn: (cmd, args, opts) => {
        spawnedCmd = cmd;
        spawnedArgs = args;
        spawnedOpts = opts;
        return fakeChild as unknown as childProcess.ChildProcess;
      },
    });

    const startTool = tools.find((t) => t.name === "ae_aerender_start")!;
    const statusTool = tools.find((t) => t.name === "ae_aerender_status")!;
    const cancelTool = tools.find((t) => t.name === "ae_aerender_cancel")!;

    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const host = new PanelHost({
      evalScript: async () => ({
        ok: true,
        result: {
          aeVersion: "26.0x68",
          project_path: "C:\\Projects\\Demo.aep",
          dirty: false,
        },
        durationMs: 3,
      }),
      queue,
      quarantine,
    });

    const outMov = path.join(dir, "out", "final.mov");
    const started = (await startTool.handler(
      {
        expect: { project_path: "c:/projects/demo.aep" },
        comp_name: "Hero Comp",
        output_path: outMov,
        output_module_template: "Lossless",
        render_settings_template: "Best Settings",
        start_frame: 1,
        end_frame: 10,
      },
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;

    expect(started.ok).toBe(true);
    expect(started.state).toBe("running");
    expect(started.pid).toBe(9876);
    expect(spawnedCmd).toBe(
      "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/aerender.exe"
    );
    expect(spawnedOpts.windowsHide).toBe(true);
    expect(spawnedOpts.detached).toBe(true);
    expect(fakeChild.unreffed).toBe(true);
    expect(spawnedArgs).toEqual([
      "-project",
      "C:\\Projects\\Demo.aep",
      "-comp",
      "Hero Comp",
      "-output",
      outMov,
      "-RStemplate",
      "Best Settings",
      "-OMtemplate",
      "Lossless",
      "-s",
      "1",
      "-e",
      "10",
    ]);

    // Verify JSON mirror was written on disk and reloads in a fresh registry
    expect(fs.existsSync(jobsJsonPath)).toBe(true);
    const reloadedRegistry = new AerenderJobRegistry(jobsJsonPath, NO_GATE);
    expect(reloadedRegistry.get(started.job_id)).toMatchObject({
      job_id: started.job_id,
      state: "running",
      comp_name: "Hero Comp",
    });

    // Emit PROGRESS lines into the job log
    fakeChild.stdout.write(
      "PROGRESS:  0:00:00:01 (1): 0 Seconds\nPROGRESS:  0:00:00:02 (2): 1 Seconds\n"
    );

    const runningStatus = (await statusTool.handler(
      { job_id: started.job_id },
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;

    expect(runningStatus.state).toBe("running");
    expect(runningStatus.exit_code).toBeNull();
    expect(runningStatus.current_frame).toBe(2);
    expect(runningStatus.frames_completed).toBe(2);
    expect(runningStatus.total_frames).toBe(10);
    expect(runningStatus.percent).toBe(20);
    expect(runningStatus.log_tail).toContain("PROGRESS:  0:00:00:02 (2)");

    // Cancel the running job
    const cancelRes = (await cancelTool.handler(
      { job_id: started.job_id },
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;

    expect(fakeChild.killed).toBe(true);
    expect(cancelRes.state).toBe("failed");
    expect(cancelRes.cancelled).toBe(true);

    const afterCancel = (await statusTool.handler(
      { job_id: started.job_id },
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;
    expect(afterCancel.state).toBe("failed");
    expect(afterCancel.cancelled).toBe(true);
  });

  it("marks job as succeeded when aerender exits with code 0", async () => {
    const dir = makeTempDir();
    const registry = new AerenderJobRegistry(path.join(dir, "jobs.json"), NO_GATE);
    const fakeChild = new FakeChildProcess(1111);

    const tools = createAerenderTools({
      registry,
      spawn: () => fakeChild as unknown as childProcess.ChildProcess,
    });
    const startTool = tools.find((t) => t.name === "ae_aerender_start")!;
    const statusTool = tools.find((t) => t.name === "ae_aerender_status")!;

    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const host = new PanelHost({
      evalScript: async () => ({
        ok: true,
        result: {
          aeVersion: "26.0x68",
          project_path: "C:/Projects/Clean.aep",
          dirty: false,
        },
        durationMs: 2,
      }),
      queue,
      quarantine,
    });

    const started = (await startTool.handler(
      {
        expect: { project_path: "C:/Projects/Clean.aep" },
        comp_name: "Comp 1",
        output_path: path.join(dir, "out.mov"),
      },
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;

    fakeChild.stdout.write(
      "PROGRESS:  0:00:00:00 (0): 0 Seconds\nPROGRESS:  Total Time Elapsed: 1 Seconds\n"
    );
    fakeChild.emit("exit", 0, null);

    const doneStatus = (await statusTool.handler(
      { job_id: started.job_id },
      { bridge: host, queue, quarantine }
    )) as Record<string, any>;

    expect(doneStatus.state).toBe("succeeded");
    expect(doneStatus.exit_code).toBe(0);
    expect(doneStatus.percent).toBe(100);
    expect(doneStatus.log_tail).toContain("Total Time Elapsed");
  });
});

// ---------- w5render: -rqindex, whole queue and the new flags ----------


const qItem = (index: number, extra: Partial<RqItemRead> = {}): RqItemRead => ({
  index,
  comp_id: 5,
  comp_name: "Hero",
  status: "queued",
  render: true,
  comp_frame_rate: 25,
  comp_duration: 4,
  time_span_start: 0,
  time_span_duration: 4,
  skip_frames: 0,
  num_output_modules: 2,
  output_modules: [
    { index: 1, name: "Output Module 1", file: "C:/out/hero.mp4" },
    { index: 2, name: "Output Module 2", file: "C:/out/hero.mov" },
  ],
  ...extra,
});

describe("w5render: ae_aerender_start schema", () => {
  const base = { expect: { project_path: "C:/proj/demo.aep" } };
  const ok = (v: object) => AeAerenderStartSchema.safeParse({ ...base, ...v }).success;

  it("takes exactly one source", () => {
    expect(ok({ comp_name: "Main", output_path: "C:/out/a.mov" })).toBe(true);
    expect(ok({ rq_index: 2, item_comp_id: 5 })).toBe(true);
    expect(ok({ whole_queue: true })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ comp_name: "Main" })).toBe(false);
    expect(ok({ output_path: "C:/out/a.mov" })).toBe(false);
    // rq_index needs its comp guard; the guard goes with rq_index only.
    expect(ok({ rq_index: 2 })).toBe(false);
    expect(ok({ comp_name: "Main", output_path: "C:/out/a.mov", item_comp_id: 5 })).toBe(false);
    expect(ok({ rq_index: 0, item_comp_id: 5 })).toBe(false);
    expect(ok({ rq_index: 2, item_comp_id: 5, whole_queue: true })).toBe(false);
    expect(ok({ whole_queue: true, comp_name: "Main" })).toBe(false);
  });

  it("comp_name next to rq_index is an extra guard, not an error (deliver fills it)", () => {
    expect(ok({ rq_index: 2, item_comp_id: 5, comp_name: "Hero" })).toBe(true);
  });

  it("refuses what would override the queue item", () => {
    for (const extra of [{ output_path: "C:/out/a.mov" }, { output_module_template: "Lossless" }, { render_settings_template: "Best Settings" }, { start_frame: 0 }, { end_frame: 3 }]) {
      expect(ok({ rq_index: 2, item_comp_id: 5, ...extra })).toBe(false);
      expect(ok({ whole_queue: true, ...extra })).toBe(false);
    }
    const r = AeAerenderStartSchema.safeParse({ ...base, rq_index: 2, item_comp_id: 5, start_frame: 0 });
    expect(r.success ? "" : r.error.issues[0].message).toMatch(/ae_render_queue_edit/);
  });

  it("takes the flags for every source and bounds them", () => {
    const flags = { continue_on_missing_footage: true, mem_usage: { image_cache_percent: 50, max_mem_percent: 80 }, log_level: "errors", sound: false };
    expect(ok({ comp_name: "Main", output_path: "C:/out/a.mov", ...flags })).toBe(true);
    expect(ok({ rq_index: 1, item_comp_id: 5, ...flags })).toBe(true);
    expect(ok({ whole_queue: true, ...flags })).toBe(true);
    expect(ok({ whole_queue: true, mem_usage: { image_cache_percent: 0, max_mem_percent: 80 } })).toBe(false);
    expect(ok({ whole_queue: true, mem_usage: { image_cache_percent: 50 } })).toBe(false);
    expect(ok({ whole_queue: true, log_level: "verbose" })).toBe(false);
    expect(ok({ whole_queue: true, log_level: "errors_and_progress" })).toBe(true);
  });

  it("converts to JSON Schema and describes the new fields", () => {
    const json = zodToJsonSchema(AeAerenderStartSchema);
    for (const k of ["rq_index", "item_comp_id", "whole_queue", "continue_on_missing_footage", "mem_usage", "log_level", "sound"]) {
      expect(json.properties).toHaveProperty(k);
      expect((json.properties as any)[k].description).toBeTruthy();
    }
    const tool = createAerenderTools().find((t) => t.name === "ae_aerender_start")!;
    expect(tool.description).toMatch(/rq_index/);
    expect(tool.description).toMatch(/Never uses -reuse/);
    expect(tool.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
  });
});

describe("w5render: buildAerenderArgs", () => {
  const p = { project_path: "C:/p/a.aep" };

  it("keeps the comp form exactly as it was", () => {
    expect(buildAerenderArgs({ ...p, comp_name: "Main", output_path: "C:/o.mov", output_module_template: "Lossless", render_settings_template: "Best", start_frame: 1, end_frame: 9, max_cpu_percent: 40 })).toEqual([
      "-project", "C:/p/a.aep", "-comp", "Main", "-output", "C:/o.mov", "-RStemplate", "Best", "-OMtemplate", "Lossless", "-s", "1", "-e", "9", "-mfr", "ON", "40",
    ]);
  });

  it("-rqindex replaces -comp and -output; the whole queue has neither", () => {
    expect(buildAerenderArgs({ ...p, rq_index: 3, comp_name: "Hero", output_path: "ignored.mov" })).toEqual(["-project", "C:/p/a.aep", "-rqindex", "3"]);
    expect(buildAerenderArgs({ ...p, whole_queue: true })).toEqual(["-project", "C:/p/a.aep"]);
  });

  it("adds the flags after the rest, and no -v unless asked (so PROGRESS stays)", () => {
    const args = buildAerenderArgs({ ...p, rq_index: 1, max_cpu_percent: 50, continue_on_missing_footage: true, mem_usage: { image_cache_percent: 40, max_mem_percent: 90 }, log_level: "errors", sound: true });
    expect(args).toEqual(["-project", "C:/p/a.aep", "-rqindex", "1", "-mfr", "ON", "50", "-continueOnMissingFootage", "-mem_usage", "40", "90", "-v", "ERRORS", "-sound", "ON"]);
    expect(buildAerenderArgs({ ...p, whole_queue: true, log_level: "errors_and_progress", sound: false })).toEqual(["-project", "C:/p/a.aep", "-v", "ERRORS_AND_PROGRESS", "-sound", "OFF"]);
    expect(buildAerenderArgs({ ...p, whole_queue: true, continue_on_missing_footage: false })).toEqual(["-project", "C:/p/a.aep"]);
  });

  it("never adds -reuse", () => {
    const all = buildAerenderArgs({ ...p, rq_index: 1, max_cpu_percent: 50, continue_on_missing_footage: true, mem_usage: { image_cache_percent: 1, max_mem_percent: 2 }, log_level: "errors", sound: true });
    expect(all.some((a) => /reuse/i.test(a))).toBe(false);
  });
});

describe("w5render: choosing a Render Queue item", () => {
  const read = (...items: RqItemRead[]) => ({ numItems: items.length, items });

  it("accepts a queued item with its comp and lists every output module", () => {
    const r = selectRqItem(read(qItem(1), qItem(2, { comp_id: 6, comp_name: "Other" })), { rq_index: 2, item_comp_id: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selection).toMatchObject({ comp_name: "Other", comp_id: 6, comp_ids: [6], item_indexes: [2], outputs: ["C:/out/hero.mp4", "C:/out/hero.mov"] });
    expect(r.selection.frame_range).toEqual({ start_frame: 0, end_frame: 99 });
  });

  it("treats comp_name as an extra guard", () => {
    expect(selectRqItem(read(qItem(1)), { rq_index: 1, item_comp_id: 5, comp_name: "Hero" }).ok).toBe(true);
    expect(selectRqItem(read(qItem(1)), { rq_index: 1, item_comp_id: 5, comp_name: "Wrong" })).toMatchObject({ ok: false, code: "rq_item_name_mismatch" });
  });

  it("refuses a missing item, another comp, and every status that is not QUEUED with the fix", () => {
    expect(selectRqItem(read(qItem(1)), { rq_index: 4, item_comp_id: 5 })).toMatchObject({ ok: false, code: "rq_item_not_found" });
    expect(selectRqItem(read(qItem(1)), { rq_index: 1, item_comp_id: 9 })).toMatchObject({ ok: false, code: "rq_item_comp_mismatch", expected: 9, actual: 5 });
    const refused = (status: string) => selectRqItem(read(qItem(1, { status })), { rq_index: 1, item_comp_id: 5 }) as { ok: false; code: string; message: string };
    expect(refused("unqueued")).toMatchObject({ code: "rq_item_not_queued" });
    expect(refused("unqueued").message).toMatch(/ae_render_queue_edit.*queued: true/);
    expect(refused("needs_output").message).toMatch(/output file/);
    expect(refused("done").message).toMatch(/ae_render_queue_duplicate/);
    expect(refused("rendering").message).toMatch(/interactive After Effects/);
    expect(refused("err_stopped").message).toMatch(/not QUEUED/);
    expect(rqStatusRefusal(3, undefined)).toMatch(/UNKNOWN/);
  });

  it("refuses an item with an output module that has no file", () => {
    const r = selectRqItem(read(qItem(1, { output_modules: [{ index: 1, file: "C:/out/a.mp4" }, { index: 2, file: null }] })), { rq_index: 1, item_comp_id: 5 });
    expect(r).toMatchObject({ ok: false, code: "rq_item_no_output" });
    expect(itemOutputs(qItem(1, { output_modules: [{ index: 1, file: "" }] }))).toEqual({ paths: [], missing: [1] });
  });

  it("derives the frame range from the time span, and gives none when skip frames or a missing rate make it unknowable", () => {
    expect(itemFrameRange(qItem(1, { time_span_start: 1, time_span_duration: 2 }))).toEqual({ start_frame: 25, end_frame: 74 });
    expect(itemFrameRange(qItem(1, { skip_frames: 1 }))).toBeUndefined();
    expect(itemFrameRange(qItem(1, { comp_frame_rate: undefined }))).toBeUndefined();
    expect(itemFrameRange(qItem(1, { time_span_duration: 0 }))).toBeUndefined();
  });

  it("whole queue: the queued items, all their outputs, comps once; refuses when none is queued", () => {
    const r = selectWholeQueue({ numItems: 3, items: [qItem(1), qItem(2, { status: "done" }), qItem(3, { comp_id: 6, output_modules: [{ index: 1, file: "C:/out/b.mov" }] })] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selection).toMatchObject({ comp_name: "<render queue>", comp_ids: [5, 6], item_indexes: [1, 3], outputs: ["C:/out/hero.mp4", "C:/out/hero.mov", "C:/out/b.mov"] });
    expect(r.selection.warnings[0]).toMatch(/1 item\(s\) are not QUEUED/);
    expect(selectWholeQueue({ numItems: 1, items: [qItem(1, { status: "unqueued" })] })).toMatchObject({ ok: false, code: "rq_queue_empty" });
    expect(selectWholeQueue({ numItems: 0, items: [] })).toMatchObject({ ok: false, code: "rq_queue_empty" });
    expect(selectWholeQueue({ numItems: 1, items: [qItem(1, { output_modules: [{ index: 1, file: null }] })] })).toMatchObject({ ok: false, code: "rq_item_no_output" });
  });
});

describe("w5render: ae_aerender_start from the Render Queue, through a fake bridge", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup(opts: { items?: RqItemRead[] | ((dir: string) => RqItemRead[]); dirty?: boolean; project?: string; footage?: (dir: string) => unknown; itemsFail?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-aerender-rq-"));
    dirs.push(dir);
    const registry = new AerenderJobRegistry(path.join(dir, "jobs.json"), NO_GATE);
    const child = new FakeChildProcess(777);
    let spawned: { cmd: string; args: readonly string[] } | null = null;
    const tools = createAerenderTools({
      registry,
      platform: "win32",
      afterFxPath: "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe",
      existsSync: () => true,
      spawn: (cmd, args) => {
        spawned = { cmd, args };
        return child as unknown as childProcess.ChildProcess;
      },
    });
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
    const calls: Array<{ fn: string; script: string }> = [];
    const given = typeof opts.items === "function" ? opts.items(dir) : opts.items;
    const items = given ?? [qItem(1), qItem(2, { comp_id: 6, comp_name: "Other", output_modules: [{ index: 1, file: path.join(dir, "out", "other.mov") }] })];
    const host = new PanelHost({
      evalScript: async (script) => {
        const fn = script.slice("__chromaAe.".length, script.indexOf("("));
        calls.push({ fn, script });
        if (fn === "status") return { ok: true, result: { aeVersion: "26.0x68", project_path: opts.project ?? "C:\\Projects\\Demo.aep", dirty: opts.dirty === true }, durationMs: 1 };
        if (fn === "preflightItems" && opts.itemsFail) return { ok: false as const, error: { kind: "unreachable", message: "panel gone" } };
        if (fn === "preflightItems") return { ok: true, result: opts.footage ? opts.footage(dir) : footagePage([]), durationMs: 1 };
        if (fn === "rqeditRead") {
          const asked = /"item_indexes":\[(\d+)\]/.exec(script);
          const list = asked ? items.filter((i) => i.index === Number(asked[1])) : items;
          return { ok: true, result: { numItems: items.length, rendering: false, items: list }, durationMs: 1 };
        }
        throw new Error(`Unexpected script: ${script}`);
      },
      queue,
      quarantine,
    });
    const start = tools.find((t) => t.name === "ae_aerender_start")!;
    const status = tools.find((t) => t.name === "ae_aerender_status")!;
    const ctx = { bridge: host, queue, quarantine };
    return { dir, registry, child, calls, start, status, ctx, spawned: () => spawned };
  }
  const expectArg = { project_path: "c:/projects/demo.aep" };

  it("renders one queue item by -rqindex, with all its outputs on the record", async () => {
    const t = setup();
    const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, rq_index: 1, item_comp_id: 5 }), t.ctx)) as Record<string, any>;
    // preflightItems: the pre-render sequence check lists the footage once (sequence_check defaults to warn).
    expect(t.calls.map((c) => c.fn)).toEqual(["status", "rqeditRead", "preflightItems"]);
    expect(t.calls[1].script).toContain('"item_indexes":[1]');
    expect(t.spawned()!.args).toEqual(["-project", "C:\\Projects\\Demo.aep", "-rqindex", "1"]);
    expect(out).toMatchObject({
      ok: true,
      source: "rq_index",
      rq_index: 1,
      item_comp_id: 5,
      comp_name: "Hero",
      output_path: "C:/out/hero.mp4",
      output_paths: ["C:/out/hero.mp4", "C:/out/hero.mov"],
      frame_range: { start_frame: 0, end_frame: 99 },
    });
    const rec = t.registry.get(out.job_id)!;
    expect(rec).toMatchObject({ comp_name: "Hero", rq_index: 1, item_comp_id: 5, comp_id: 5, output_paths: ["C:/out/hero.mp4", "C:/out/hero.mov"], start_frame: 0, end_frame: 99 });
    // The frame range is for the record only: aerender must not get -s / -e.
    expect(rec.args).not.toContain("-s");
    expect(rec.args).not.toContain("-e");
    expect(typeof rec.comp_name).toBe("string");
  });

  it("makes the output folder of every module before the spawn", async () => {
    const t = setup({
      items: (dir) => [qItem(1, { output_modules: [{ index: 1, file: path.join(dir, "deliver", "sub", "a.mp4") }, { index: 2, file: path.join(dir, "deliver2", "b.mov") }] })],
    });
    await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, rq_index: 1, item_comp_id: 5 }), t.ctx);
    expect(fs.existsSync(path.join(t.dir, "deliver", "sub"))).toBe(true);
    expect(fs.existsSync(path.join(t.dir, "deliver2"))).toBe(true);
  });

  it("status reports the rq fields; progress of several items in a row does not crash", async () => {
    const t = setup();
    const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, whole_queue: true }), t.ctx)) as Record<string, any>;
    t.child.stdout.write(
      [
        'PROGRESS:  Starting composition "Hero".',
        "PROGRESS:  0:00:00:00 (0): 0 Seconds",
        "PROGRESS:  0:00:00:01 (1): 0 Seconds",
        'PROGRESS:  Starting composition "Other".',
        "PROGRESS:  0:00:00:00 (0): 0 Seconds",
      ].join("\n") + "\n"
    );
    const running = (await t.status.handler({ job_id: out.job_id }, t.ctx)) as Record<string, any>;
    expect(running).toMatchObject({ state: "running", whole_queue: true, comp_name: "<render queue>", current_frame: 0 });
    expect(running.percent).toBeNull();
    expect(running.output_paths).toHaveLength(3);
    t.child.emit("exit", 0, null);
    const done = (await t.status.handler({ job_id: out.job_id }, t.ctx)) as Record<string, any>;
    expect(done).toMatchObject({ state: "succeeded", percent: 100 });
  });

  it("renders the whole queue with neither -comp nor -rqindex, and lists every queued output", async () => {
    const t = setup();
    const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, whole_queue: true, continue_on_missing_footage: true }), t.ctx)) as Record<string, any>;
    expect(t.spawned()!.args).toEqual(["-project", "C:\\Projects\\Demo.aep", "-continueOnMissingFootage"]);
    expect(t.calls[1].script).not.toContain("item_indexes\":[");
    expect(out).toMatchObject({ source: "whole_queue", comp_name: "<render queue>", queued_items: [1, 2] });
    expect(out.output_paths).toHaveLength(3);
    expect(t.registry.get(out.job_id)).toMatchObject({ whole_queue: true, comp_name: "<render queue>" });
  });

  describe("missing frames in image sequences and the GPU", () => {
    let restore: (() => void) | null = null;
    const savedDeps = { ...resourceDeps };
    afterEach(() => {
      restore?.();
      restore = null;
      Object.assign(resourceDeps, savedDeps);
      resetResourceCache();
    });
    const gappy = (dir: string) => {
      const first = makeSequence(path.join(dir, "seq"), { skip: [6, 7] });
      const old = useOldFiles();
      restore = old.restore;
      return { first, old };
    };
    const outFile = (dir: string) => path.join(dir, "o.mov");

    it("warns by default and still spawns: sequence_check and a warnings line", async () => {
      let first = "";
      const t = setup({ footage: (dir) => footagePage([{ file: (first = gappy(dir).first), name: "plate" }]) });
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t.dir) }), t.ctx)) as Record<string, any>;
      expect(first).not.toBe("");
      expect(out.ok).toBe(true);
      expect(t.spawned()).not.toBeNull();
      expect(out.sequence_check).toMatchObject({ with_gaps: 1 });
      expect(out.warnings.join(" ")).toMatch(/missing frames.*0006-0007/);
    });

    it("keeps the queue warnings and adds the sequence one", async () => {
      const t = setup({ footage: (dir) => footagePage([{ file: gappy(dir).first }]) });
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, whole_queue: true }), t.ctx)) as Record<string, any>;
      expect(out.warnings).toHaveLength(1);
      const t2 = setup({ items: [qItem(1), qItem(2, { status: "done" })], footage: (dir) => footagePage([{ file: gappy(dir).first }]) });
      const out2 = (await t2.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, whole_queue: true }), t2.ctx)) as Record<string, any>;
      expect(out2.warnings).toHaveLength(2);
      expect(out2.warnings[0]).toMatch(/not QUEUED/);
      expect(out2.warnings[1]).toMatch(/missing frames/);
    });

    it("block refuses before the job exists: no spawn, no record", async () => {
      const t = setup({ footage: (dir) => footagePage([{ file: gappy(dir).first }]) });
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t.dir), sequence_check: "block" }), t.ctx)) as Record<string, any>;
      expect(out).toMatchObject({ ok: false, error: "sequence_gaps", applied: false });
      expect(t.spawned()).toBeNull();
      expect(t.registry.list()).toHaveLength(0);
    });

    it("a footage list that cannot be read never refuses a warn: the job starts and the result says what failed", async () => {
      const t = setup({ itemsFail: true });
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t.dir) }), t.ctx)) as Record<string, any>;
      expect(out.ok).toBe(true);
      expect(t.spawned()).not.toBeNull();
      expect(out.sequence_check.error).toMatch(/panel gone/);
      expect(out.warnings.join(" ")).toMatch(/Sequence check incomplete.*panel gone/);
      // block refuses, and says why and that warn proceeds
      const b = setup({ itemsFail: true });
      const refused = (await b.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(b.dir), sequence_check: "block" }), b.ctx)) as Record<string, any>;
      expect(refused).toMatchObject({ ok: false, error: "sequence_check_incomplete", applied: false });
      expect(refused.message).toMatch(/could not be checked.*"warn"/);
      expect(b.spawned()).toBeNull();
    });

    it("reads the folders after the queue lease is released, then starts", async () => {
      let held: boolean | null = null;
      const seqDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-seqlease-"));
      dirs.push(seqDir);
      const first = gappy(seqDir).first;
      const t = setup({ footage: () => footagePage([{ file: first }]) });
      const wrapped = seqscanDeps.io;
      seqscanDeps.io = { ...wrapped, readdir: async (d, limit) => ((held = t.ctx.queue.inFlight !== null), wrapped.readdir(d, limit)) };
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t.dir) }), t.ctx)) as Record<string, any>;
      expect(held).toBe(false);
      expect(out.ok).toBe(true);
      expect(out.sequence_check.with_gaps).toBe(1);
    });

    it("off does not read the footage list", async () => {
      const t = setup({ footage: (dir) => footagePage([{ file: gappy(dir).first }]) });
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t.dir), sequence_check: "off" }), t.ctx)) as Record<string, any>;
      expect(out.ok).toBe(true);
      expect(out.sequence_check).toBeUndefined();
      expect(t.calls.map((c) => c.fn)).not.toContain("preflightItems");
    });

    it("adds resource_warnings at a nearly full GPU and still spawns; none when the card has room", async () => {
      const probe = (usedGb: number, withBlender = true) => {
        resetResourceCache();
        Object.assign(resourceDeps, {
          platform: () => "win32" as const,
          run: async () => ({ ok: true, adapters: [{ luid: "a", used_mb: usedGb * 1024 }], totals: [{ name: "RTX 4090", total_mb: 24 * 1024 }], processes: withBlender ? [{ pid: 9120, name: "blender", gpu_mb: 3200 }] : [] }),
        });
      };
      probe(22.5);
      const t = setup();
      const out = (await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t.dir) }), t.ctx)) as Record<string, any>;
      expect(out.ok).toBe(true);
      expect(t.spawned()).not.toBeNull();
      expect(out.resource_warnings[0]).toMatch(/94 % full/);
      expect(out.resource_warnings.join(" ")).toMatch(/Blender \(pid 9120\) is running and holds the largest share/);
      probe(8, false);
      const t2 = setup();
      const quiet = (await t2.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: outFile(t2.dir) }), t2.ctx)) as Record<string, any>;
      expect(quiet.ok).toBe(true);
      expect("resource_warnings" in quiet).toBe(false);
      expect(t.start.description).toMatch(/If `resource_warnings` is present, tell the user before continuing/);
    });
  });

  it("passes the flags on a plain comp job too, and no -v when log_level is left out", async () => {
    const t = setup();
    await t.start.handler(
      AeAerenderStartSchema.parse({ expect: expectArg, comp_name: "Main", output_path: path.join(t.dir, "o.mov"), mem_usage: { image_cache_percent: 30, max_mem_percent: 70 }, sound: false }),
      t.ctx
    );
    const args = t.spawned()!.args;
    expect(args.slice(0, 6)).toEqual(["-project", "C:\\Projects\\Demo.aep", "-comp", "Main", "-output", path.join(t.dir, "o.mov")]);
    expect(args.slice(6)).toEqual(["-mem_usage", "30", "70", "-sound", "OFF"]);
    expect(args).not.toContain("-v");
  });

  it("comp_name next to rq_index must be the item's comp", async () => {
    const t = setup();
    await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, rq_index: 1, item_comp_id: 5, comp_name: "Hero" }), t.ctx);
    expect(t.spawned()).not.toBeNull();
    const t2 = setup();
    await expect(t2.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, rq_index: 1, item_comp_id: 5, comp_name: "Nope" }), t2.ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(t2.spawned()).toBeNull();
  });

  it("refuses with a reason and spawns nothing: dirty, wrong comp, not queued, no item, nothing queued", async () => {
    const dirty = setup({ dirty: true });
    await expect(dirty.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, rq_index: 1, item_comp_id: 5 }), dirty.ctx)).rejects.toThrow(/ae_save/);
    expect(dirty.calls.map((c) => c.fn)).toEqual(["status"]);
    expect(dirty.spawned()).toBeNull();

    const refuse = async (args: object, items?: RqItemRead[]) => {
      const t = setup({ items });
      let err: any;
      try {
        await t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, ...args }), t.ctx);
      } catch (e) {
        err = e;
      }
      expect(t.spawned()).toBeNull();
      expect(t.registry.list()).toHaveLength(0);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.kind).toBe("guard");
      return err as BridgeError;
    };
    expect((await refuse({ rq_index: 1, item_comp_id: 99 })).message).toMatch(/comp 5.*not 99/);
    expect((await refuse({ rq_index: 1, item_comp_id: 5 }, [qItem(1, { status: "unqueued" })])).message).toMatch(/queued: true/);
    expect((await refuse({ rq_index: 1, item_comp_id: 5 }, [qItem(1, { status: "done" })])).message).toMatch(/DONE/);
    expect((await refuse({ rq_index: 7, item_comp_id: 5 })).message).toMatch(/No Render Queue item 7/);
    expect((await refuse({ whole_queue: true }, [qItem(1, { status: "unqueued" })])).message).toMatch(/No item in the Render Queue is QUEUED/);
  });

  it("keeps refusing an unsaved or other project for a queue source", async () => {
    const t = setup({ project: "C:/work/other.aep" });
    await expect(t.start.handler(AeAerenderStartSchema.parse({ expect: expectArg, rq_index: 1, item_comp_id: 5 }), t.ctx)).rejects.toMatchObject({ kind: "guard" });
    expect(t.calls.map((c) => c.fn)).toEqual(["status"]);
  });
});
