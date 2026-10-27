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
  AeAerenderStartSchema,
  AeAerenderStatusSchema,
  AerenderJobRegistry,
  MACOS_FALLBACK_AERENDER,
  WINDOWS_FALLBACK_AERENDER,
  createAerenderTools,
  parseAerenderProgress,
  resolveAerenderPath,
} from "../src/tools/ext/aerender.js";

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
    const registry = new AerenderJobRegistry(path.join(dir, "jobs.json"));
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
    const registry = new AerenderJobRegistry(jobsJsonPath);

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
    const reloadedRegistry = new AerenderJobRegistry(jobsJsonPath);
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
    const registry = new AerenderJobRegistry(path.join(dir, "jobs.json"));
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
