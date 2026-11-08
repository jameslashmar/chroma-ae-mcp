import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { renderGate } from "../src/render-gate.js";
import type { ToolContext } from "../src/tools/common.js";
import { AerenderJobRegistry, bindFailureLog, type AerenderJobRecord } from "../src/tools/ext/aerender.js";
import { followDeps, resetFollowState } from "../src/tools/ext/rqfollow.js";
import { RenderJobStore, bindJobFailureLog, runRenderJob, type JobItem } from "../src/tools/ext/rqrender.js";
import { renderTools } from "../src/tools/render.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const common = require("../../panel/client/common.js");

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-jobfail-"));
  tmpDirs.push(d);
  return d;
};
beforeEach(() => {
  renderGate.reset();
  resetFollowState();
});
afterEach(() => {
  renderGate.reset();
  resetFollowState();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Turns the service-log call into the line the panel reads. */
const asLine = (level: string, msg: string) => `[10:00:00] [${level.toUpperCase()}] ${msg}`;

describe("a failed aerender job writes one [ERR] line", () => {
  const rec = (id: string): AerenderJobRecord => ({
    job_id: id, pid: 1, state: "running", exit_code: null, signal: null, cancelled: false, project_path: "C:/p.aep", comp_name: "Main",
    output_path: "C:/o.mov", aerender_path: "aerender", args: [], log_path: path.join(os.tmpdir(), "x.log"), started_at: new Date().toISOString(), finished_at: null,
  });

  it("logs the tool, the job id and the reason once; not for success or a cancelled job", () => {
    const reg = new AerenderJobRegistry(path.join(tmp(), "jobs.json"), { cool_down_ms: 0, list_engines: () => [] });
    const lines: string[] = [];
    bindFailureLog(reg, (l, m) => lines.push(asLine(l, m)));
    reg.register(rec("job_a"));
    reg.register(rec("job_b"));
    reg.register(rec("job_c"));
    reg.update("job_a", { state: "failed", error: "aerender never started rendering", finished_at: "t" });
    reg.update("job_a", { error: "changed later" });
    reg.update("job_b", { state: "succeeded", finished_at: "t" });
    reg.update("job_c", { state: "failed", cancelled: true, finished_at: "t" });
    expect(lines).toEqual(["[10:00:00] [ERR] job ae_aerender_start job_a failed: aerender never started rendering"]);
    // The panel counts it as an error and not as a call.
    const stats = common.createSessionStats(20);
    for (const l of lines) stats.ingest(l);
    expect(stats.snapshot()).toMatchObject({ calls: 0, errors: 1 });
  });

  it("a throwing log never breaks the registry", () => {
    const reg = new AerenderJobRegistry(path.join(tmp(), "jobs.json"), { cool_down_ms: 0, list_engines: () => [] });
    bindFailureLog(reg, () => {
      throw new Error("log closed");
    });
    reg.register(rec("job_a"));
    expect(reg.update("job_a", { state: "failed", error: "x" })?.state).toBe("failed");
  });
});

function renderCtx(handlers: Record<string, () => unknown>, log?: ToolContext["log"]) {
  const dir = tmp();
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const calls: string[] = [];
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      const h = handlers[fn];
      if (!h) return { ok: true as const, result: { fn }, durationMs: 1 };
      const r = h();
      if (r instanceof Promise) return { ok: true as const, result: await r, durationMs: 1 };
      if (r instanceof Error) return { ok: false as const, error: { kind: "host_error", message: r.message }, durationMs: 1 } as any;
      return { ok: true as const, result: r, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir, ...(log ? { log } : {}) };
  return { ctx, calls, dir, queue };
}

describe("a Render Queue render that ends failed or unknown writes one [ERR] line", () => {
  const items: JobItem[] = [{ index: 1, comp_id: 5, outputs: [] }];
  async function run(handlers: Record<string, () => unknown>, timeoutMs = 2000) {
    const lines: string[] = [];
    const { ctx, queue } = renderCtx(handlers, (l, m) => lines.push(asLine(l, m)));
    const store = new RenderJobStore(path.join(tmp(), "rqjobs.json"));
    const lease = await queue.acquire("render");
    store.create({ job_id: "rqjob_t", op_id: "op_t", state: "running", started_at: new Date().toISOString(), max_hours: 1, project_path: "<unsaved>", overwrite: false, items });
    await runRenderJob({ ctx, store, jobId: "rqjob_t", opId: "op_t", lease, timeoutMs, items });
    return { lines, rec: store.get("rqjob_t")! };
  }

  it("a render call that times out: unknown, one line", async () => {
    const { lines, rec } = await run({ rqeditRender: () => new Promise(() => undefined) }, 30);
    expect(rec.state).toBe("unknown");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[10:00:00\] \[ERR\] job ae_render_queue_render rqjob_t ended unknown: /);
    const stats = common.createSessionStats(20);
    stats.ingest(lines[0]);
    expect(stats.snapshot().errors).toBe(1);
  });

  it("an error raised by AE from the render call: failed, one line with the reason", async () => {
    const { lines, rec } = await run({ rqeditRender: () => new Error("Render Queue is empty") });
    expect(rec.state).toBe("failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[ERR\] job ae_render_queue_render rqjob_t failed: .*Render Queue is empty/);
  });

  it("a good render writes no line", async () => {
    const { lines, rec } = await run({
      rqeditRenderResult: () => ({ rendering: false, numItems: 1, items: [{ index: 1, comp_id: 5, comp_name: "Main", status: "done", comp_matches: true, elapsed_seconds: 4 }] }),
    });
    expect(rec.state).toBe("finished");
    expect(lines).toEqual([]);
  });

  it("the store reports a job once, however often it is updated", () => {
    const store = new RenderJobStore(path.join(tmp(), "rqjobs.json"));
    const lines: string[] = [];
    bindJobFailureLog(store, (l, m) => lines.push(asLine(l, m)));
    store.create({ job_id: "j", op_id: "o", state: "running", started_at: "t", max_hours: 1, project_path: "p", overwrite: false, items });
    store.update("j", { state: "unknown", note: "n" });
    store.update("j", { state: "failed", error: "later" });
    store.update("j", { note: "again" });
    expect(lines).toHaveLength(1);
  });
});

// ---------- following a render the user started by hand ----------

describe("ae_render_queue_status follows RENDERING and QUEUED items", () => {
  const statusTool = renderTools.find((t) => t.name === "ae_render_queue_status")!;
  const status = (n: number) => ({ numItems: n, rendering: true, items: [] as unknown[] });
  const queueRead = (files: Record<string, string>) => ({
    numItems: 3,
    rendering: true,
    items: [
      { index: 1, comp_id: 5, comp_name: "Main", status: "rendering", output_modules: [{ index: 1, file: files.a }] },
      { index: 2, comp_id: 6, comp_name: "Alt", status: "queued", output_modules: [{ index: 1, file: files.b }] },
      { index: 3, comp_id: 7, comp_name: "Old", status: "done", output_modules: [{ index: 1, file: files.c }] },
    ],
  });

  it("names follow in its description", () => {
    expect(statusTool.description).toMatch(/follow/);
  });

  it("gives exists, bytes, mtime and grew_since_last_check (null on the first call) for RENDERING and QUEUED items only", async () => {
    const dir = tmp();
    const files = { a: path.join(dir, "a.mov"), b: path.join(dir, "b.mov"), c: path.join(dir, "c.mov") };
    fs.writeFileSync(files.a, "12345");
    fs.writeFileSync(files.c, "x");
    const { ctx } = renderCtx({ rqStatus: () => status(3), rqeditRead: () => queueRead(files) });
    const first: any = await statusTool.handler({}, ctx);
    expect(first.numItems).toBe(3); // today's answer is kept
    expect(first.follow.items.map((i: any) => [i.index, i.status])).toEqual([[1, "rendering"], [2, "queued"]]);
    expect(first.follow.items[0].outputs[0]).toMatchObject({ file: files.a, exists: true, bytes: 5, grew_since_last_check: null });
    expect(typeof first.follow.items[0].outputs[0].mtime).toBe("string");
    expect(first.follow.items[1].outputs[0]).toMatchObject({ exists: false, bytes: 0, grew_since_last_check: null });
    expect(first.follow.note).toMatch(/sign of life/);

    fs.appendFileSync(files.a, "678");
    const second: any = await statusTool.handler({}, ctx);
    expect(second.follow.items[0].outputs[0]).toMatchObject({ bytes: 8, grew_since_last_check: true });
    const third: any = await statusTool.handler({}, ctx);
    expect(third.follow.items[0].outputs[0]).toMatchObject({ bytes: 8, grew_since_last_check: false });
  });

  it("follows at most 20 items", async () => {
    const dir = tmp();
    const many = Array.from({ length: 25 }, (_, i) => ({ index: i + 1, comp_id: i, comp_name: `C${i}`, status: "queued", output_modules: [{ index: 1, file: path.join(dir, `o${i}.mov`) }] }));
    const { ctx } = renderCtx({ rqStatus: () => status(25), rqeditRead: () => ({ numItems: 25, items: many }) });
    const res: any = await statusTool.handler({}, ctx);
    expect(res.follow.items).toHaveLength(20);
    expect(res.follow.truncated).toBe(true);
  });

  it("when AE does not answer, answers from the last successful read with a note; with nothing earlier it fails as before", async () => {
    const dir = tmp();
    const files = { a: path.join(dir, "a.mov"), b: path.join(dir, "b.mov"), c: path.join(dir, "c.mov") };
    fs.writeFileSync(files.a, "123");
    let down = false;
    const { ctx } = renderCtx({
      rqStatus: () => (down ? new BridgeError({ kind: "timeout", message: "timed out" }) : status(3)),
      rqeditRead: () => queueRead(files),
    });
    // Nothing earlier and AE down: the error is the tool's, as it was.
    down = true;
    await expect(statusTool.handler({}, ctx)).rejects.toThrow();
    down = false;
    await statusTool.handler({}, ctx);
    fs.appendFileSync(files.a, "45");
    down = true;
    const res: any = await statusTool.handler({}, ctx);
    expect(res).toMatchObject({ ok: true, answered_from_earlier_read: true });
    expect(res.follow.from_earlier_read).toBe(true);
    expect(res.follow.note).toMatch(/did not answer in time/);
    expect(res.follow.items[0].outputs[0]).toMatchObject({ bytes: 5, grew_since_last_check: true });
    expect(followDeps.answerTimeoutMs).toBeLessThan(15000);
  });
});
