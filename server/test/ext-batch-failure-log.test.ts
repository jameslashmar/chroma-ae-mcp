import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import {
  AerenderJobRegistry,
  bindFailureLog,
  formatJobFailureLine,
  type AerenderJobRecord,
} from "../src/tools/ext/aerender.js";
import { BatchStore, createRenderbatchTools } from "../src/tools/ext/renderbatch.js";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-batchfail-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const rec = (id: string, extra: Partial<AerenderJobRecord> = {}): AerenderJobRecord => ({
  job_id: id, pid: 1, state: "running", exit_code: null, signal: null, cancelled: false, project_path: "C:/p.aep", comp_name: "Main",
  output_path: "C:/o.mov", aerender_path: "aerender", args: [], log_path: path.join(os.tmpdir(), "x.log"), started_at: new Date().toISOString(), finished_at: null,
  ...extra,
});

const newRegistry = () => new AerenderJobRegistry(path.join(tmp(), "jobs.json"), { cool_down_ms: 0, list_engines: () => [] });

describe("the [ERR] line of a failed aerender job", () => {
  it("falls back to the exit code, then the signal, when no error text was recorded", () => {
    expect(formatJobFailureLine("ae_aerender_start", "j1", undefined, { exit_code: 3, signal: null })).toBe("job ae_aerender_start j1 failed: exit code 3");
    expect(formatJobFailureLine("ae_aerender_start", "j1", undefined, { exit_code: null, signal: "SIGKILL" })).toBe("job ae_aerender_start j1 failed: signal SIGKILL");
    expect(formatJobFailureLine("ae_aerender_start", "j1", "", { exit_code: 1 })).toBe("job ae_aerender_start j1 failed: exit code 1");
    expect(formatJobFailureLine("ae_aerender_start", "j1", "never started", { exit_code: 1 })).toBe("job ae_aerender_start j1 failed: never started");
    expect(formatJobFailureLine("ae_aerender_start", "j1", undefined)).toBe("job ae_aerender_start j1 failed: no reason recorded");
  });

  it("a plain non-zero exit is logged with its exit code, not 'no reason recorded'", () => {
    const reg = newRegistry();
    const lines: string[] = [];
    bindFailureLog(reg, (l, m) => lines.push(`${l}: ${m}`));
    reg.register(rec("job_a"));
    reg.update("job_a", { state: "failed", exit_code: 2, signal: null, finished_at: "t" });
    expect(lines).toEqual(["err: job ae_aerender_start job_a failed: exit code 2"]);
  });

  it("names the tool that launched the job, and binding the same log twice logs one line", () => {
    const reg = newRegistry();
    const lines: string[] = [];
    const log = (l: string, m: string) => lines.push(`${l}: ${m}`);
    bindFailureLog(reg, log);
    bindFailureLog(reg, log);
    reg.register(rec("job_b", { launched_by: "ae_render_batch" }));
    reg.register(rec("job_s"));
    reg.update("job_b", { state: "failed", exit_code: 1, finished_at: "t" });
    reg.update("job_s", { state: "failed", error: "boom", finished_at: "t" });
    expect(lines).toEqual(["err: job ae_render_batch job_b failed: exit code 1", "err: job ae_aerender_start job_s failed: boom"]);
  });
});

describe("ae_render_batch binds the failure log on its own registry", () => {
  const ctxWith = (log: ToolContext["log"]): ToolContext =>
    ({ quarantine: { assertClear() {} }, bridge: { newOpId: () => "op_1" }, log }) as unknown as ToolContext;
  const args = (tool: string) => ({
    expect: { project_path: "C:/p.aep" },
    batch_id: "batch_1700000000000_abcdef",
  });

  for (const toolName of ["ae_render_batch", "ae_render_batch_resume"]) {
    it(`${toolName} binds it, and a failed batch item then logs under ae_render_batch`, async () => {
      const registry = newRegistry();
      const tools = createRenderbatchTools({ registry, store: new BatchStore(path.join(tmp(), "batches")), autoTick: false });
      const tool = tools.find((t) => t.name === toolName)!;
      const lines: string[] = [];
      expect(registry.failureSink).toBeNull();
      // The handler is cut short (no such batch / invalid job); the binding comes first.
      await Promise.resolve(tool.handler(args(toolName) as never, ctxWith((l, m) => lines.push(`${l}: ${m}`)))).catch(() => undefined);
      expect(registry.failureSink).not.toBeNull();
      registry.register(rec("job_x", { launched_by: "ae_render_batch" }));
      registry.update("job_x", { state: "failed", exit_code: 7, finished_at: "t" });
      expect(lines).toEqual(["err: job ae_render_batch job_x failed: exit code 7"]);
    });
  }
});
