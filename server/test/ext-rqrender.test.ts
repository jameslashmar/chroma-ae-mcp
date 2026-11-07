import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge.js";
import { BridgeError } from "../src/host.js";
import { createPanelMcp } from "../src/panel-entry.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { QueueWaitError, SingleWriterQueue } from "../src/queue.js";
import { renderGate, renderGateMessage } from "../src/render-gate.js";
import { AGENT_SAFETY_GUIDANCE, type ToolContext } from "../src/tools/common.js";
import { AssetWatcher } from "../src/tools/ext/assets.js";
import { AerenderJobRegistry, createAerenderTools } from "../src/tools/ext/aerender.js";
import { AskStore } from "../src/asks.js";
import { askTools } from "../src/tools/ext/ask.js";
import { panelsTools } from "../src/tools/ext/panels.js";
import { getSessionTracker, installSessionBridgeHook, installSessionTracking, resetSessionTracking } from "../src/tools/ext/session.js";
import {
  AeRenderQueueRenderSchema,
  AeRenderQueueRenderStatusSchema,
  RenderJobStore,
  beginRenderGate,
  jobsFileFor,
  judgeResult,
  liveOutputsFrom,
  planStart,
  renderTimeoutMs,
  resetRenderJobStores,
  stillRendering,
  rqrenderDeps,
  rqrenderTools,
  runRenderJob,
  sequenceRegex,
  statOutput,
  storeFor,
  type JobItem,
} from "../src/tools/ext/rqrender.js";
import { readTools } from "../src/tools/read.js";
import { writeDiagnostics } from "../src/tools/ext/diagnostics.js";
import { FakeFile, FakeProject, loadHost } from "./support/fake-ae.js";
import { footagePage, makeSequence, useOldFiles } from "./support/seq-fixtures.js";
import { resetResourceCache, resourceDeps } from "../src/system-resources.js";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-rqrender-"));
  tmpDirs.push(d);
  return d;
};

beforeEach(() => {
  renderGate.reset();
  resetRenderJobStores();
});
afterEach(() => {
  renderGate.reset();
  resetRenderJobStores();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => rqrenderTools.find((t) => t.name === name)!;
const expectArg = { project_path: "<unsaved>" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------- a PanelHost over a script of host results ----------

interface RigOptions {
  /** What rqeditRead returns. */
  queue?: unknown;
  /** The render's own eval: pending until resolved by the test. */
  render?: () => Promise<unknown>;
  /** What rqeditRenderResult returns (or throws); may return a promise. */
  result?: () => unknown;
  /** Runs while the start check reads the queue (to put something in the queue's line meanwhile). */
  onRead?: () => Promise<void> | void;
  /** What sessionSnapshot returns. */
  snapshot?: () => unknown;
  /** No serviceInfo on the context: not inside the panel service. */
  noService?: boolean;
  /** What preflightItems returns (the footage list the sequence check reads). */
  items?: unknown;
  /** preflightItems fails with an unreachable panel. */
  itemsFail?: boolean;
}

function rig(opts: RigOptions = {}) {
  const dir = tmp();
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const calls: Array<{ fn: string; label: string }> = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const file = path.join(outDir, "a.mp4");
  const defaultQueue = {
    numItems: 1,
    rendering: false,
    items: [{ index: 1, comp_id: 5, comp_name: "Main", status: "queued", output_modules: [{ index: 1, file }] }],
  };
  const host = new PanelHost({
    evalScript: async (script, label) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push({ fn, label });
      const ok = (result: unknown) => ({ ok: true as const, result, durationMs: 1 });
      switch (fn) {
        case "checkGuard":
          return ok({ ok: true, project_path: "<unsaved>", comp_id: null, comp_is_valid: true });
        case "rqeditRead":
          await opts.onRead?.();
          return ok(opts.queue ?? defaultQueue);
        case "preflightItems":
          if (opts.itemsFail) return { ok: false as const, error: { kind: "unreachable", message: "panel gone" } };
          return ok(opts.items ?? footagePage([]));
        case "sessionSnapshot":
          return ok(opts.snapshot ? opts.snapshot() : { project_path: "<unsaved>", fn });
        case "rqeditRender":
          return ok(await (opts.render ? opts.render() : Promise.resolve({ returned: true })));
        case "rqeditRenderResult":
          return ok(
            opts.result
              ? await opts.result()
              : { rendering: false, numItems: 1, items: [{ index: 1, comp_id: 5, comp_name: "Main", status: "done", comp_matches: true, elapsed_seconds: 42 }] }
          );
        default:
          return ok({ project_path: "<unsaved>", fn });
      }
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir: dir, ...(opts.noService ? {} : { serviceInfo: () => ({ inFlight: null }) }) };
  return { ctx, host, queue, quarantine, calls, dir, outDir, file };
}

const startTool = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  tool("ae_render_queue_render").handler(AeRenderQueueRenderSchema.parse({ expect: expectArg, ...extra }), ctx) as Promise<Record<string, any>>;
const statusTool = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  tool("ae_render_queue_render_status").handler(AeRenderQueueRenderStatusSchema.parse(extra), ctx) as Promise<Record<string, any>>;

// ---------- schemas and descriptions ----------

describe("rqrender schemas and descriptions", () => {
  it("takes expect, and max_hours between 1 and 48 (default 12)", () => {
    expect(AeRenderQueueRenderSchema.safeParse({}).success).toBe(false);
    const ok = AeRenderQueueRenderSchema.parse({ expect: expectArg });
    expect(ok.max_hours).toBe(12);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, max_hours: 0.5 }).success).toBe(false);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, max_hours: 49 }).success).toBe(false);
    expect(AeRenderQueueRenderSchema.safeParse({ expect: expectArg, max_hours: 48, overwrite: true }).success).toBe(true);
    expect(AeRenderQueueRenderStatusSchema.safeParse({}).success).toBe(true);
    expect(AeRenderQueueRenderStatusSchema.safeParse({ job_id: "" }).success).toBe(false);
  });

  it("tells agents when to use it, and never to ask the user to press Render", () => {
    const d = tool("ae_render_queue_render").description;
    expect(d.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
    expect(d).toMatch(/ae_aerender_start/);
    expect(d).toMatch(/busy/i);
    expect(d).toMatch(/TELL THE USER FIRST/);
    expect(d).toMatch(/NEVER ask the user to press Render/);
    expect(d).toMatch(/Stop button/);
    expect(d).toMatch(/not measured/);
    expect(d).toMatch(/unsaved/i);
    const s = tool("ae_render_queue_render_status").description;
    expect(s).toMatch(/NEVER touches After Effects/);
    expect(s).toMatch(/sign of life, not progress/);
    expect(s).toMatch(/ae_verify_render/);
  });

  it("aerender points here when it fails to start", () => {
    const start = createAerenderTools().find((t) => t.name === "ae_aerender_start")!;
    expect(start.description).toMatch(/ae_render_queue_render/);
    expect(start.description.endsWith(AGENT_SAFETY_GUIDANCE)).toBe(true);
  });
});

// ---------- the start checks ----------

describe("planStart", () => {
  const q = (items: unknown[], rendering = false) => ({ numItems: items.length, rendering, items } as any);
  const item = (file: string | null, extra: Record<string, unknown> = {}) => ({
    index: 1,
    comp_id: 5,
    comp_name: "Main",
    status: "queued",
    output_modules: [{ index: 1, file }],
    ...extra,
  });

  it("refuses a queue that is rendering, one with nothing queued, and an unreadable one", () => {
    const dir = tmp();
    const f = path.join(dir, "a.mp4");
    expect(planStart(q([item(f)], true), false).refusals.map((r) => r.code)).toContain("already_rendering");
    expect(planStart(q([item(f, { status: "done" })]), false).refusals.map((r) => r.code)).toEqual(["nothing_queued"]);
    expect(planStart(null, false).refusals.map((r) => r.code)).toEqual(["nothing_queued"]);
  });

  it("refuses an output with no file, a missing folder, and an existing file unless overwrite", () => {
    const dir = tmp();
    expect(planStart(q([item(null)]), false).refusals.map((r) => r.code)).toEqual(["no_output_file"]);
    expect(planStart(q([item(path.join(dir, "nope", "deeper", "a.mp4"))]), false).refusals.map((r) => r.code)).toEqual(["folder_missing"]);
    expect(fs.existsSync(path.join(dir, "nope"))).toBe(false); // nothing was created
    const f = path.join(dir, "a.mp4");
    fs.writeFileSync(f, "x");
    expect(planStart(q([item(f)]), false).refusals.map((r) => r.code)).toEqual(["output_exists"]);
    expect(planStart(q([item(f)]), true).refusals).toEqual([]);
    expect(fs.readFileSync(f, "utf8")).toBe("x"); // never deleted
  });

  it("sees existing frames of an image sequence", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "shot_00001.png"), "x");
    fs.writeFileSync(path.join(dir, "other_00001.png"), "x");
    const seq = path.join(dir, "shot_[#####].png");
    expect(sequenceRegex("shot_[#####].png").test("shot_00001.png")).toBe(true);
    expect(sequenceRegex("shot_[#####].png").test("shot_1.png")).toBe(false);
    const plan = planStart(q([item(seq)]), false);
    expect(plan.refusals.map((r) => r.code)).toEqual(["output_exists"]);
    expect(planStart(q([item(path.join(dir, "fresh_[#####].png"))]), false).refusals).toEqual([]);
    const st = statOutput({ item_index: 1, module: 1, file: seq });
    expect(st).toMatchObject({ sequence: true, exists: true, frame_count: 1, bytes: 1 });
  });

  it("plans every queued item's outputs and skips items that are not queued", () => {
    const dir = tmp();
    const plan = planStart(
      q([item(path.join(dir, "a.mp4")), { ...item(path.join(dir, "b.mp4")), index: 2, status: "done" }, { ...item(path.join(dir, "c.mp4")), index: 3 }]),
      false
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.items.map((i) => i.index)).toEqual([1, 3]);
  });
});

// ---------- the tool: refusals ----------

describe("ae_render_queue_render refusals", () => {
  it("refuses before anything starts and lets the queue go", async () => {
    const queue = { numItems: 1, rendering: false, items: [{ index: 1, comp_id: 5, comp_name: "Main", status: "done", output_modules: [{ index: 1, file: "C:\\x\\a.mp4" }] }] };
    const r = rig({ queue });
    const out = await startTool(r.ctx);
    expect(out.started).toBe(false);
    expect(out.refused[0].code).toBe("nothing_queued");
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
    expect(renderGate.active()).toBeNull();
    expect(r.queue.inFlight).toBeNull(); // the lease was released
    expect(storeFor(r.ctx).list()).toHaveLength(0);
  });

  it("refuses an existing output file and tells what to do", async () => {
    const r = rig();
    fs.writeFileSync(r.file, "old");
    const out = await startTool(r.ctx);
    expect(out.started).toBe(false);
    expect(out.refused[0].code).toBe("output_exists");
    expect(fs.readFileSync(r.file, "utf8")).toBe("old");
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
  });

  it("refuses a second render while one runs", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const first = await startTool(r.ctx);
    expect(first.started).toBe(true);
    const second = await startTool(r.ctx);
    expect(second.started).toBe(false);
    expect(second.refused[0].code).toBe("already_rendering");
    d.resolve({ returned: true });
    await storeFor(r.ctx).done(first.job_id);
  });
});

// ---------- the tool: returns at once, gate, completion ----------

describe("ae_render_queue_render while the render runs", () => {
  it("returns at once, refuses other evals without sending them or quarantining, then lifts", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx, { max_hours: 2 });
    // The render has NOT ended, and the call has already returned.
    expect(out).toMatchObject({ ok: true, started: true, state: "running", max_hours: 2 });
    expect(typeof out.job_id).toBe("string");
    expect(out.items[0].outputs[0].file).toBe(r.file);
    expect(out.note).toMatch(/Stop button/);
    expect(renderGate.active()?.job_id).toBe(out.job_id);
    await tick();
    expect(r.calls.map((c) => c.fn).filter((f) => f === "rqeditRender")).toHaveLength(1);

    const sentBefore = r.calls.length;
    // callHost (the door every tool uses), a guarded write's queue lease, and a bare evalRaw: all refused at once.
    const t0 = Date.now();
    await expect(r.host.callHost("getProject", {}, { label: "ae_get_project", mutates: false })).rejects.toThrow(/After Effects is rendering \(job rqjob_/);
    await expect(r.host.callHost("setProperty", {}, { label: "w", mutates: true, toolName: "ae_set_property" })).rejects.toBeInstanceOf(BridgeError);
    await expect(r.queue.run("write", async () => "never")).rejects.toThrow(/rendering/);
    await expect(r.host.evalRaw({ id: "x1", script: "__chromaAe.status({})", label: "x", mutates: true, toolName: "t" })).rejects.toThrow(/Check ae_render_queue_render_status/);
    expect(Date.now() - t0).toBeLessThan(500);
    const err = await r.host.callHost("getProject", {}, { label: "g", mutates: false }).catch((e) => e);
    expect(err.kind).toBe("queued");
    expect(r.calls.length).toBe(sentBefore); // nothing was sent to AE
    expect(r.quarantine.list()).toHaveLength(0);

    // Node-only tools keep working and never touch AE.
    const st = await statusTool(r.ctx, { include_dialogs: false });
    expect(st).toMatchObject({ state: "running", job_id: out.job_id });
    expect(st.sign_of_life.note).toMatch(/sign of life, not progress/);
    expect(st.stop).toMatch(/Stop button/);
    expect(r.calls.length).toBe(sentBefore);

    d.resolve({ returned: true });
    await storeFor(r.ctx).done(out.job_id);

    expect(renderGate.active()).toBeNull();
    // The result was read in a SEPARATE evalScript, after the render's own.
    const fns = r.calls.map((c) => c.fn);
    expect(fns.indexOf("rqeditRenderResult")).toBeGreaterThan(fns.indexOf("rqeditRender"));
    const ready = await r.host.callHost("getProject", {}, { label: "ae_get_project", mutates: false });
    expect(ready.result).toBeDefined();
    expect(r.quarantine.list()).toHaveLength(0);

    const done = await statusTool(r.ctx, { job_id: out.job_id, include_dialogs: false });
    expect(done.state).toBe("finished");
    expect(done.item_statuses[0]).toMatchObject({ status: "done", elapsed_seconds: 42 });
    // The output file does not exist on disk, so the verdict is not ok even though the item is DONE.
    expect(done.render_ok).toBe(false);
    expect(done.summary).toMatch(/missing or empty/);
    expect(done.next).toMatch(/ae_verify_render/);
  });

  it("is ok when the item is DONE and the file has bytes", async () => {
    const r = rig();
    const out = await startTool(r.ctx);
    fs.writeFileSync(r.file, "frames");
    await storeFor(r.ctx).done(out.job_id);
    const done = await statusTool(r.ctx, { include_dialogs: false });
    expect(done).toMatchObject({ state: "finished", render_ok: true });
    expect(done.outputs[0]).toMatchObject({ exists: true, bytes: 6 });
  });

  it("reports USER_STOPPED and ERR_STOPPED honestly", async () => {
    const r = rig({ result: () => ({ rendering: false, numItems: 1, items: [{ index: 1, comp_id: 5, status: "user_stopped", comp_matches: true }] }) });
    const out = await startTool(r.ctx);
    await storeFor(r.ctx).done(out.job_id);
    const done = await statusTool(r.ctx, { include_dialogs: false });
    expect(done.render_ok).toBe(false);
    expect(done.summary).toMatch(/Stopped by the user/);
    const j = judgeResult(
      [{ index: 1, comp_id: 5, outputs: [] }],
      { items: [{ index: 1, comp_id: 5, status: "err_stopped", comp_matches: true }] },
      undefined
    );
    expect(j.summary).toMatch(/error/i);
  });

  it("a failed read-back after the render is stored in the job, not thrown, and the gate lifts", async () => {
    const r = rig({
      result: () => {
        throw new Error("AE would not answer the read-back");
      },
    });
    const out = await startTool(r.ctx);
    await storeFor(r.ctx).done(out.job_id);
    const rec = storeFor(r.ctx).get(out.job_id)!;
    expect(rec.state).toBe("finished");
    expect(rec.ok).toBe(false);
    expect(rec.result?.read_back_error).toMatch(/would not answer/);
    expect(rec.summary).toMatch(/could not be read back/);
    expect(renderGate.active()).toBeNull();
    expect(r.queue.inFlight).toBeNull();
  });

  it("an error raised by the render call itself fails the job and still reads the items", async () => {
    const r = rig({
      render: async () => {
        throw new Error("render() refused");
      },
    });
    const out = await startTool(r.ctx);
    await storeFor(r.ctx).done(out.job_id);
    const rec = storeFor(r.ctx).get(out.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toMatch(/render\(\) refused/);
    expect(r.calls.map((c) => c.fn)).toContain("rqeditRenderResult");
    expect(renderGate.active()).toBeNull();
  });

  it("drops operations already waiting for the queue when the render takes it", async () => {
    const queue = new SingleWriterQueue();
    const lease = await queue.acquire("holder");
    const waiting = queue.acquire("waiter");
    waiting.catch(() => undefined);
    expect(queue.rejectWaiting(() => new QueueWaitError("waiter", 0, "holder"))).toBe(1);
    await expect(waiting).rejects.toBeInstanceOf(QueueWaitError);
    expect(queue.depth).toBe(0);
    lease.release();
    expect(queue.inFlight).toBeNull();
  });
});

// ---------- timeout: the outcome is unknown ----------

describe("a render that outlasts its time limit", () => {
  it("is reported unknown, never resent, never quarantined, and keeps the gate shut until the panel is idle", async () => {
    const r = rig({ render: () => new Promise(() => undefined) }); // never returns, like a render that is still going
    const store = storeFor(r.ctx);
    const lease = await r.queue.acquire("render");
    const info = { job_id: "rqjob_t", op_id: "op_t", started_at: new Date().toISOString() };
    const items: JobItem[] = [{ index: 1, comp_id: 5, outputs: [] }];
    store.create({ job_id: "rqjob_t", op_id: "op_t", state: "running", started_at: info.started_at, max_hours: 1, project_path: "<unsaved>", overwrite: false, items });
    beginRenderGate(store, info);
    let idle = false;
    renderGate.setIdleProbe(() => idle);
    await runRenderJob({ ctx: r.ctx, store, jobId: "rqjob_t", opId: "op_t", lease, timeoutMs: 30, items });

    const rec = store.get("rqjob_t")!;
    expect(rec.state).toBe("unknown");
    expect(rec.note).toMatch(/outcome is unknown/);
    expect(rec.note).toMatch(/Nothing was resent/);
    expect(r.calls.filter((c) => c.fn === "rqeditRender")).toHaveLength(1);
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRenderResult"); // no read-back behind a blocked AE
    expect(r.quarantine.list()).toHaveLength(0);
    expect(r.queue.inFlight).toBeNull(); // the lease is released

    // The gate stays shut: AE is still inside the render call.
    expect(renderGate.active()?.state).toBe("unknown");
    await expect(r.host.callHost("getProject", {}, { label: "g", mutates: false })).rejects.toThrow(/may still be busy rendering/);
    const st = await statusTool(r.ctx, { include_dialogs: false });
    expect(st.state).toBe("unknown");
    expect(st.note).toMatch(/Look at After Effects/);

    // The panel service has nothing in flight again: the gate lifts.
    idle = true;
    expect(renderGate.active()).toBeNull();
    expect(store.get("rqjob_t")!.note).toMatch(/may never have been read/);
    await r.host.callHost("getProject", {}, { label: "g", mutates: false });
  });

  it("passes the limit to the eval (48 hours) and clamps anything above the timer maximum", async () => {
    const seen: number[] = [];
    const r = rig();
    const realEval = r.host.evalRaw.bind(r.host);
    (r.host as any).evalRaw = (p: any) => {
      if (p.toolName === "ae_render_queue_render" && p.mutates === true) seen.push(p.timeoutMs);
      return realEval(p);
    };
    const out = await startTool(r.ctx, { max_hours: 48 });
    await storeFor(r.ctx).done(out.job_id);
    expect(seen).toEqual([48 * 3_600_000]);
    expect(renderTimeoutMs(48)).toBe(48 * 3_600_000);
    expect(renderTimeoutMs(1_000_000)).toBe(2_147_000_000);
    expect(renderTimeoutMs(1_000_000)).toBeLessThan(2_147_483_647);
  });
});

// ---------- restart ----------

describe("a service restart during a render", () => {
  it("reports the job as lost instead of running for ever", async () => {
    const r = rig();
    const file = jobsFileFor(r.ctx);
    const first = new RenderJobStore(file);
    first.create({
      job_id: "rqjob_old",
      op_id: "op_old",
      state: "running",
      started_at: new Date(Date.now() - 3600_000).toISOString(),
      max_hours: 12,
      project_path: "<unsaved>",
      overwrite: false,
      items: [{ index: 1, comp_id: 5, outputs: [{ item_index: 1, comp_id: 5, module: 1, file: r.file, sequence: false }] }],
    });
    // A new process: the cached stores are gone and the file is read again.
    resetRenderJobStores();
    const st = await statusTool(r.ctx, { include_dialogs: false });
    expect(st.state).toBe("lost");
    expect(st.note).toMatch(/look at After Effects/i);
    expect(st.note).toMatch(/Nothing was resent/);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).jobs[0].state).toBe("lost");
    // And nothing is gated: a fresh process has no gate.
    expect(renderGate.active()).toBeNull();
  });
});

// ---------- status never touches AE ----------

describe("ae_render_queue_render_status", () => {
  it("never calls evalRaw or the queue, and reads dialogs without screenshots", async () => {
    const r = rig();
    const store = storeFor(r.ctx);
    store.create({
      job_id: "rqjob_s",
      op_id: "op_s",
      state: "running",
      started_at: new Date().toISOString(),
      max_hours: 12,
      project_path: "<unsaved>",
      overwrite: false,
      items: [{ index: 1, comp_id: 5, outputs: [{ item_index: 1, comp_id: 5, module: 1, file: r.file, sequence: false }] }],
    });
    let evals = 0;
    (r.host as any).evalRaw = () => {
      evals++;
      throw new Error("evalRaw must not be called");
    };
    (r.host as any).callHost = () => {
      evals++;
      throw new Error("callHost must not be called");
    };
    const asked: unknown[] = [];
    const real = rqrenderDeps.listDialogs;
    rqrenderDeps.listDialogs = (async (o: { screenshots: boolean }) => {
      asked.push(o);
      return { ok: true, dialogs: [{ title: "Missing file", buttons: [{ name: "OK" }] }] };
    }) as typeof rqrenderDeps.listDialogs;
    try {
      const first = await statusTool(r.ctx);
      expect(first.dialogs).toHaveLength(1);
      expect(first.dialogs_note).toMatch(/ae_dialogs/);
      expect(asked).toEqual([{ screenshots: false }]);
      expect(first.outputs[0]).toMatchObject({ exists: false, bytes: 0 });
      // A file appears and grows: a sign of life.
      fs.writeFileSync(r.file, "ab");
      const second = await statusTool(r.ctx, { include_dialogs: false });
      expect(second.outputs[0]).toMatchObject({ exists: true, bytes: 2 });
      expect(second.sign_of_life.files_written_since_start).toBe(1);
      expect(second.sign_of_life.grew_since_last_check).toBe(true);
    } finally {
      rqrenderDeps.listDialogs = real;
    }
    expect(evals).toBe(0);
  });

  it("says so when there is no job or an unknown id", async () => {
    const r = rig();
    expect(await statusTool(r.ctx, { include_dialogs: false })).toMatchObject({ ok: false, error: "no_jobs" });
    expect(await statusTool(r.ctx, { job_id: "nope", include_dialogs: false })).toMatchObject({ ok: false, error: "unknown_job" });
  });

  it("counts frames and bytes of an image sequence", () => {
    const dir = tmp();
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(dir, `seq_${String(i).padStart(5, "0")}.png`), "12345");
    fs.writeFileSync(path.join(dir, "readme.txt"), "x");
    expect(statOutput({ item_index: 1, module: 1, file: path.join(dir, "seq_[#####].png") })).toMatchObject({ exists: true, frame_count: 3, bytes: 15 });
  });
});

// ---------- the other doors: ae_status, diagnostics, asset watcher ----------

describe("other tools while rendering", () => {
  it("ae_status answers with the render state instead of failing", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    const sentBefore = r.calls.length;
    const status = tool0(readTools, "ae_status");
    const res = (await status.handler({}, r.ctx)) as Record<string, any>;
    expect(res.rendering).toMatchObject({ job_id: out.job_id, state: "rendering" });
    expect(res.message).toMatch(/ae_render_queue_render_status/);
    expect(r.calls.length).toBe(sentBefore);
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
    // After it ends the normal path is back.
    const after = (await status.handler({}, r.ctx)) as Record<string, any>;
    expect(after.rendering).toBeUndefined();
    expect(after.project_path).toBe("<unsaved>");
  });

  it("ae_diagnostics still writes its file and does not send a status eval", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    const sentBefore = r.calls.length;
    const diag = await writeDiagnostics(r.ctx, undefined, { includeDialogs: false });
    expect(fs.existsSync(diag.path)).toBe(true);
    expect((diag.summary as any).ae_answered).toBe(false);
    expect((diag.summary as any).render_gate).toMatchObject({ job_id: out.job_id });
    expect(r.calls.length).toBe(sentBefore);
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
  });

  it("the asset watcher poll skips quietly and logs nothing", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    const sentBefore = r.calls.length;
    const logs: string[] = [];
    const ctx = {
      ...r.ctx,
      settings: { get: () => ({ asset_watch: { enabled: true, since: null } }) },
    } as unknown as ToolContext;
    const watcher = new AssetWatcher(ctx, { log: (_l, m) => logs.push(m) });
    for (let i = 0; i < 3; i++) expect(await watcher.tick()).toBeNull();
    expect(logs).toEqual([]);
    expect(r.calls.length).toBe(sentBefore);
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
  });
});

function tool0(list: Array<{ name: string; handler: (a: any, c: ToolContext) => Promise<unknown> }>, name: string) {
  return list.find((t) => t.name === name)!;
}

// ---------- the host functions against the fake AE ----------

describe("rqeditRender and rqeditRenderResult (fake AE)", () => {
  const STATUS = { WILL_CONTINUE: 1, NEEDS_OUTPUT: 2, UNQUEUED: 3, QUEUED: 4, RENDERING: 5, USER_STOPPED: 6, ERR_STOPPED: 7, DONE: 8 };

  function scene(statuses: number[]) {
    const project = new FakeProject();
    const comp = project.addComp("Main Film", 1920, 1080, 10);
    let renders = 0;
    const items = statuses.map((status) => ({
      status,
      comp,
      elapsedSeconds: 7,
      startTime: { getTime: () => 1700000000000 },
      numOutputModules: 1,
      outputModule: () => ({ file: new FakeFile("C:\\out\\a.mp4") }),
    }));
    const rq = {
      rendering: false,
      numItems: items.length,
      item: (i: number) => items[i - 1],
      render: () => {
        renders++;
        for (const it of items) if (it.status === STATUS.QUEUED) it.status = STATUS.DONE;
      },
    };
    (project as unknown as { renderQueue: unknown }).renderQueue = rq;
    const { A, G } = loadHost(project, ["rqedit.jsx"]);
    Object.assign(G, { RQItemStatus: STATUS });
    return { A, rq, items, renders: () => renders, comp };
  }

  it("calls render() once for queued items and nothing else", () => {
    const s = scene([STATUS.QUEUED, STATUS.DONE]);
    const out = JSON.parse(JSON.stringify(s.A.rqeditRender({})));
    expect(out).toMatchObject({ returned: true, queued_items: 1 });
    expect(s.renders()).toBe(1);
  });

  it("refuses when the queue is rendering or nothing is queued, without calling render()", () => {
    const busy = scene([STATUS.QUEUED]);
    busy.rq.rendering = true;
    expect(() => busy.A.rqeditRender({})).toThrow(/already rendering/);
    expect(busy.renders()).toBe(0);
    const none = scene([STATUS.DONE]);
    expect(() => none.A.rqeditRender({})).toThrow(/No Render Queue item is QUEUED/);
    expect(none.renders()).toBe(0);
  });

  it("reads status, elapsed time and files in a separate call", () => {
    const s = scene([STATUS.QUEUED]);
    s.A.rqeditRender({});
    const out = JSON.parse(JSON.stringify(s.A.rqeditRenderResult({ indexes: [1], comp_ids: [s.comp.id] })));
    expect(out.items[0]).toMatchObject({ index: 1, status: "done", elapsed_seconds: 7, comp_matches: true });
    expect(out.items[0].output_modules[0].file).toBe("C:\\out\\a.mp4");
    const moved = JSON.parse(JSON.stringify(s.A.rqeditRenderResult({ indexes: [1], comp_ids: [99999] })));
    expect(moved.items[0].comp_matches).toBe(false);
    const gone = JSON.parse(JSON.stringify(s.A.rqeditRenderResult({ indexes: [5], comp_ids: [1] })));
    expect(gone.items[0].error).toMatch(/No render queue item 5/);
  });
});

// ---------- review fixes ----------

const fastDeps = () => {
  const saved = { sleep: rqrenderDeps.sleep, max: rqrenderDeps.stillRenderingMaxMs, poll: rqrenderDeps.stillRenderingPollMs, rb: rqrenderDeps.readBackTimeoutMs, live: rqrenderDeps.liveOutputs };
  rqrenderDeps.sleep = () => Promise.resolve();
  return () => {
    rqrenderDeps.sleep = saved.sleep;
    rqrenderDeps.stillRenderingMaxMs = saved.max;
    rqrenderDeps.stillRenderingPollMs = saved.poll;
    rqrenderDeps.readBackTimeoutMs = saved.rb;
    rqrenderDeps.liveOutputs = saved.live;
  };
};

describe("the gate stays shut while After Effects says it is rendering", () => {
  it("stillRendering reads the queue flag and the item statuses; judgeResult says the render is not over", () => {
    expect(stillRendering({ rendering: true, items: [] })).toBe(true);
    expect(stillRendering({ rendering: false, items: [{ index: 1, comp_id: 1, status: "will_continue" }] })).toBe(true);
    expect(stillRendering({ rendering: false, items: [{ index: 1, comp_id: 1, status: "rendering" }] })).toBe(true);
    expect(stillRendering({ rendering: false, items: [{ index: 1, comp_id: 1, status: "done" }] })).toBe(false);
    expect(stillRendering(null)).toBe(false);
    const j = judgeResult([{ index: 1, comp_id: 5, outputs: [] }], { rendering: true, items: [{ index: 1, comp_id: 5, status: "done", comp_matches: true }] });
    expect(j.ok).toBe(false);
    expect(j.summary).toMatch(/still reports that it is rendering/);
  });

  it("keeps the gate shut and repeats the read-back until AE stops saying rendering", async () => {
    const restore = fastDeps();
    try {
      let reads = 0;
      let gateDuringPoll: string | undefined;
      const seenIds: string[] = [];
      const r = rig({
        result: () => {
          reads++;
          gateDuringPoll = renderGate.active()?.state;
          if (reads < 3) return { rendering: true, numItems: 1, items: [{ index: 1, comp_id: 5, status: "rendering", comp_matches: true }] };
          return { rendering: false, numItems: 1, items: [{ index: 1, comp_id: 5, status: "done", comp_matches: true }] };
        },
      });
      const realEval = r.host.evalRaw.bind(r.host);
      (r.host as any).evalRaw = (p: any) => {
        seenIds.push(p.id);
        return realEval(p);
      };
      const out = await startTool(r.ctx);
      fs.writeFileSync(r.file, "frames");
      await storeFor(r.ctx).done(out.job_id);
      expect(reads).toBe(3);
      expect(gateDuringPoll).toBe("rendering"); // still shut at the last poll
      expect(seenIds.filter((i) => /_after\d*$/.test(i))).toHaveLength(3);
      expect(new Set(seenIds).size).toBe(seenIds.length); // every read has its own op id
      expect(storeFor(r.ctx).get(out.job_id)).toMatchObject({ state: "finished", ok: true });
      expect(renderGate.active()).toBeNull();
    } finally {
      restore();
    }
  });

  it("gives up after its bound: the job is unknown and the idle probe does not lift the gate", async () => {
    const restore = fastDeps();
    try {
      rqrenderDeps.stillRenderingMaxMs = -1;
      const r = rig({ result: () => ({ rendering: true, numItems: 1, items: [{ index: 1, comp_id: 5, status: "rendering", comp_matches: true }] }) });
      renderGate.setIdleProbe(() => true);
      const out = await startTool(r.ctx);
      await storeFor(r.ctx).done(out.job_id);
      const rec = storeFor(r.ctx).get(out.job_id)!;
      expect(rec.state).toBe("unknown");
      expect(rec.note).toMatch(/kept reporting that it is rendering/);
      expect(renderGate.active()).toMatchObject({ state: "unknown", cause: "still_rendering" });
      await expect(r.host.callHost("getProject", {}, { label: "g", mutates: false })).rejects.toThrow(/still reported rendering/);
      expect(r.queue.inFlight).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("a read-back that times out", () => {
  it("says the read of the result timed out, not the render call, and keeps the gate shut", async () => {
    const restore = fastDeps();
    try {
      rqrenderDeps.readBackTimeoutMs = 30;
      const r = rig({ result: () => new Promise(() => undefined) });
      const out = await startTool(r.ctx);
      await storeFor(r.ctx).done(out.job_id);
      const g = renderGate.active()!;
      expect(g).toMatchObject({ state: "unknown", cause: "read_back_timeout" });
      const msg = renderGateMessage(g);
      expect(msg).toMatch(/read of the result after the render timed out/);
      expect(msg).not.toMatch(/render call timed out/);
      expect(msg).toMatch(/restarting After Effects clears it/);
      const rec = storeFor(r.ctx).get(out.job_id)!;
      expect(rec.result?.read_back_error).toMatch(/timed out/);
    } finally {
      restore();
    }
  });
});

describe("an unreachable panel during the render", () => {
  it("makes the job unknown, resends nothing and lifts the gate (the panel is gone)", async () => {
    const r = rig();
    const realEval = r.host.evalRaw.bind(r.host);
    (r.host as any).evalRaw = (p: any) => {
      if (p.toolName === "ae_render_queue_render" && p.mutates === true) return Promise.reject(new BridgeError({ kind: "unreachable", message: "panel gone" }));
      return realEval(p);
    };
    const out = await startTool(r.ctx);
    await storeFor(r.ctx).done(out.job_id);
    const rec = storeFor(r.ctx).get(out.job_id)!;
    expect(rec.state).toBe("unknown");
    expect(rec.note).toMatch(/could not be reached/);
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRenderResult");
    expect(renderGate.active()).toBeNull();
    expect(r.queue.inFlight).toBeNull();
  });
});

describe("only the panel service may start a render", () => {
  it("is refused without serviceInfo, before anything is read or sent", async () => {
    const r = rig({ noService: true });
    const out = await startTool(r.ctx);
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].code).toBe("not_in_panel");
    expect(out.refused[0].message).toMatch(/300 s/);
    expect(r.calls).toHaveLength(0);
    expect(renderGate.active()).toBeNull();
  });
});

describe("the tool's reply goes out before the render eval", () => {
  it("sends rqeditRender one macrotask after the handler returned", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    expect(out.started).toBe(true);
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
    await tick(20);
    expect(r.calls.map((c) => c.fn)).toContain("rqeditRender");
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
  });

  it("drops an operation that was already waiting for the queue when the render started", async () => {
    let waiter: Promise<unknown> | undefined;
    const r = rig({
      onRead: () => {
        waiter = r.queue.acquire("someone else");
        waiter.catch(() => undefined);
      },
      render: () => new Promise(() => undefined),
    });
    const out = await startTool(r.ctx);
    expect(out.started).toBe(true);
    await expect(waiter).rejects.toMatchObject({ kind: "queued" });
    await expect(waiter).rejects.toThrow(/After Effects is rendering/);
    expect(r.queue.depth).toBe(0);
  });
});

describe("a gate that has to be cleared", () => {
  it("the refusal and the status tool say that restarting After Effects clears it", async () => {
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    const err = await r.host.callHost("getProject", {}, { label: "g", mutates: false }).catch((e) => e);
    expect(err.message).toMatch(/restarting After Effects clears it/);
    const st = await statusTool(r.ctx, { include_dialogs: false });
    expect(st.gate_note).toMatch(/restarting After Effects clears it/);
    expect(st.gate_note).toMatch(/Clear render lock/);
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
  });

  it("clear() (the panel button) opens the gate, frees the queue lease, and marks the job unknown", async () => {
    const r = rig({ render: () => new Promise(() => undefined) });
    const out = await startTool(r.ctx);
    expect(r.queue.inFlight).toBe("ae_render_queue_render");
    expect(renderGate.clear()?.job_id).toBe(out.job_id);
    expect(renderGate.active()).toBeNull();
    expect(r.queue.inFlight).toBeNull();
    const rec = storeFor(r.ctx).get(out.job_id)!;
    expect(rec.state).toBe("unknown");
    expect(rec.note).toMatch(/user cleared the render lock/);
    expect(renderGate.clear()).toBeNull(); // nothing left to clear
  });

  it("a late end() of an old job cannot open the gate of a newer one", () => {
    renderGate.begin({ job_id: "new", op_id: "op_new", started_at: "t" });
    renderGate.end("old");
    expect(renderGate.active()?.job_id).toBe("new");
    renderGate.end("new");
    expect(renderGate.active()).toBeNull();
  });

  it("the panel's idle probe reads serviceInfo().inFlight and lifts an unknown gate only when it is null", () => {
    const dir = tmp();
    let inFlight: unknown = { id: "x" };
    const mcp = createPanelMcp({ dataDir: dir, sessionTracking: false, watchAssets: false, evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }), serviceInfo: () => ({ inFlight }) });
    renderGate.begin({ job_id: "j", op_id: "o", started_at: "t" });
    renderGate.markUnknown("render_timeout");
    expect(mcp.renderLock()?.info.job_id).toBe("j");
    expect(mcp.renderLock()?.message).toMatch(/may still be busy rendering/);
    expect(renderGate.active()).not.toBeNull(); // the panel is busy
    inFlight = null;
    expect(renderGate.active()).toBeNull();
    expect(mcp.renderLock()).toBeNull();
    // Without serviceInfo the probe says "not idle", so an unknown gate lasts.
    renderGate.reset();
    const bare = createPanelMcp({ dataDir: dir, sessionTracking: false, watchAssets: false, evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }) });
    renderGate.begin({ job_id: "j2", op_id: "o2", started_at: "t" });
    renderGate.markUnknown();
    expect(renderGate.active()).not.toBeNull();
    // The user's button.
    expect(bare.clearRenderLock()?.job_id).toBe("j2");
    expect(renderGate.active()).toBeNull();
  });
});

describe("the dev transport (BridgeClient) honours the gate", () => {
  it("refuses at once without calling fetch, lets the render's own eval through, and does not quarantine its timeout", async () => {
    const dir = tmp();
    const tokenPath = path.join(dir, "token");
    fs.writeFileSync(tokenPath, "tok");
    let fetches = 0;
    const quarantine = new QuarantineStore(path.join(dir, "q.json"));
    const timeoutErr = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const client = new BridgeClient({
      tokenPath,
      quarantine,
      fetchImpl: (async () => {
        fetches++;
        throw timeoutErr;
      }) as unknown as typeof fetch,
    });
    renderGate.begin({ job_id: "j", op_id: "op_r", started_at: "t" });
    await expect(client.evalRaw({ id: "other", script: "1", label: "x", mutates: true, toolName: "t" })).rejects.toThrow(/After Effects is rendering/);
    await expect(client.callHost("getProject", {}, { label: "g", mutates: false })).rejects.toBeInstanceOf(BridgeError);
    expect(fetches).toBe(0);
    const own: any = await client.evalRaw({ id: "op_r", script: "1", label: "render", mutates: true, toolName: "ae_render_queue_render", timeoutMs: 10 }).catch((e) => e);
    expect(own.kind).toBe("timeout");
    expect(own.message).not.toMatch(/quarantine/);
    expect(fetches).toBe(1);
    expect(quarantine.list()).toHaveLength(0);
  });
});

describe("planStart: the limits, collisions and folders", () => {
  const q = (items: unknown[], extra: Record<string, unknown> = {}) => ({ numItems: items.length, rendering: false, items, ...extra } as any);
  const item = (index: number, file: string | null, extra: Record<string, unknown> = {}) => ({
    index,
    comp_id: 5,
    comp_name: "Main",
    status: "queued",
    output_modules: [{ index: 1, file }],
    ...extra,
  });

  it("refuses more than 100 QUEUED items and a read that was cut short", () => {
    const dir = tmp();
    const many = Array.from({ length: 101 }, (_, i) => item(i + 1, path.join(dir, `f${i}.mp4`)));
    expect(planStart(q(many), false).refusals.map((r) => r.code)).toContain("too_many_items");
    expect(planStart(q(many.slice(0, 100)), false).refusals).toEqual([]);
    expect(planStart(q([item(1, path.join(dir, "a.mp4"))], { truncated: true }), false).refusals.map((r) => r.code)).toContain("queue_truncated");
    expect(planStart(q([item(1, path.join(dir, "a.mp4"), { output_modules_truncated: true })]), false).refusals.map((r) => r.code)).toContain("queue_truncated");
  });

  it("refuses two outputs on one file, across items and modules, case and slash insensitive", () => {
    const dir = tmp();
    const a = path.join(dir, "Out.mp4");
    const two = planStart(q([item(1, a), item(2, a.replace(/\\/g, "/").toLowerCase())]), false);
    expect(two.refusals.map((r) => r.code)).toEqual(["duplicate_output"]);
    expect(two.refusals[0].message).toMatch(/item 2/);
    const mods = item(1, a, { output_modules: [{ index: 1, file: a }, { index: 2, file: a }] });
    expect(planStart(q([mods]), false).refusals.map((r) => r.code)).toEqual(["duplicate_output"]);
    // An item that is not queued does not render, so it is no collision.
    expect(planStart(q([item(1, a), item(2, a, { status: "done" })]), false).refusals).toEqual([]);
  });

  it("refuses an output a running aerender job or batch is going to write", () => {
    const dir = tmp();
    const a = path.join(dir, "a.mp4");
    const plan = planStart(q([item(1, a)]), false, [{ file: a.toUpperCase(), owner: "aerender job job_1" }]);
    expect(plan.refusals.map((r) => r.code)).toEqual(["output_in_use"]);
    expect(plan.refusals[0].message).toMatch(/aerender job job_1/);
    const whole = planStart(q([item(1, a)]), false, [{ file: "", owner: "aerender job job_2 (it renders the whole Render Queue)" }]);
    expect(whole.refusals.map((r) => r.code)).toEqual(["output_in_use"]);
  });

  it("liveOutputsFrom reads running aerender jobs and unfinished batch items, not finished ones", () => {
    const dir = tmp();
    const reg = new AerenderJobRegistry(path.join(dir, "renders", "jobs.json"));
    const base = { pid: null, exit_code: null, signal: null, cancelled: false, project_path: "C:/p.aep", comp_name: "Main", aerender_path: "a", args: [], log_path: path.join(dir, "l.log"), started_at: "t", finished_at: null };
    reg.register({ ...base, job_id: "job_run", state: "running", output_path: "C:/o/a.mp4" });
    reg.register({ ...base, job_id: "job_rq", state: "running", output_path: "C:/o/b.mov", output_paths: ["C:/o/b.mov", "C:/o/c.png"] });
    reg.register({ ...base, job_id: "job_done", state: "succeeded", output_path: "C:/o/d.mp4" });
    reg.register({ ...base, job_id: "job_wq", state: "running", output_path: "<render queue>", whole_queue: true });
    const bdir = path.join(dir, "renders", "batches", "batch_1700000000000_abcdef");
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(
      path.join(bdir, "batch.json"),
      JSON.stringify({
        batch_id: "batch_1700000000000_abcdef",
        state: "running",
        items: [
          { state: "pending", output_path: "C:/o/e.mp4" },
          { state: "succeeded", output_path: "C:/o/f.mp4" },
        ],
      })
    );
    const files = liveOutputsFrom(reg).map((l) => l.file);
    expect(files).toEqual(expect.arrayContaining(["C:/o/a.mp4", "C:/o/b.mov", "C:/o/c.png", "C:/o/e.mp4", ""]));
    expect(files).not.toContain("C:/o/d.mp4");
    expect(files).not.toContain("C:/o/f.mp4");
    expect(files).not.toContain("<render queue>");
  });

  it("the tool refuses a live collision (through the seam) and starts nothing", async () => {
    const restore = fastDeps();
    try {
      const r = rig();
      rqrenderDeps.liveOutputs = () => [{ file: r.file, owner: "aerender job job_x" }];
      const out = await startTool(r.ctx);
      expect(out.started).toBe(false);
      expect(out.refused[0].code).toBe("output_in_use");
      expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
    } finally {
      restore();
    }
  });

  it("a missing folder under an existing parent is a warning (Save in subfolder); with no parent it is a refusal", async () => {
    const dir = tmp();
    const sub = path.join(dir, "sub", "a.mp4");
    const plan = planStart(q([item(1, sub)]), false);
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings[0]).toMatch(/Save in subfolder/);
    expect(plan.items[0].outputs).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "sub"))).toBe(false);
    const r = rig({ queue: q([item(1, sub)]) });
    const out = await startTool(r.ctx);
    expect(out.started).toBe(true);
    expect(out.warnings[0]).toMatch(/does not exist yet/);
    await storeFor(r.ctx).done(out.job_id);
  });

  it("refuses an item checked to render that has no output (needs_output)", () => {
    const dir = tmp();
    const stuck = { index: 2, comp_id: 6, comp_name: "B", status: "needs_output", render: true, output_modules: [{ index: 1, file: null }] };
    const plan = planStart(q([item(1, path.join(dir, "a.mp4")), stuck]), false);
    expect(plan.refusals.map((r) => r.code)).toEqual(["needs_output"]);
    const unchecked = planStart(q([item(1, path.join(dir, "a.mp4")), { ...stuck, render: false }]), false);
    expect(unchecked.refusals).toEqual([]);
  });

  it("names ae_render_queue_duplicate for DONE items, not a queued: true edit that is refused", () => {
    const dir = tmp();
    const plan = planStart(q([item(1, path.join(dir, "a.mp4"), { status: "done" })]), false);
    expect(plan.refusals[0].code).toBe("nothing_queued");
    expect(plan.refusals[0].message).toMatch(/ae_render_queue_duplicate/);
  });
});

describe("text that must stay true", () => {
  it("the job's next step names one real file, never a [#####] path", async () => {
    const r = rig();
    const out = await startTool(r.ctx);
    await storeFor(r.ctx).done(out.job_id);
    const done = await statusTool(r.ctx, { include_dialogs: false });
    expect(done.next).toMatch(/one real/);
    expect(done.next).toMatch(/not a file/);
  });

  it("the stop text follows the Scripting Guide; the tool text asks to save first and warns about a service reload", () => {
    const d = tool("ae_render_queue_render").description;
    expect(d).toMatch(/onStatusChanged or app\.onError/);
    expect(d).not.toMatch(/cannot run while render\(\) blocks/);
    expect(d).toMatch(/ASK THEM TO SAVE FIRST/);
    expect(d).toMatch(/port stays closed until the render ends/);
    expect(d).toMatch(/restarting After Effects clears it/);
    expect(d).toMatch(/not the dev stdio server/);
  });
});

describe("other tools that call CEP directly are gated during a render", () => {
  it("ae_open_panel and ae_list_panels are refused at once and do not touch CEP", async () => {
    let cepCalls = 0;
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    const ctx = {
      ...r.ctx,
      cep: {
        listExtensions: () => {
          cepCalls++;
          return [];
        },
        openExtension: () => {
          cepCalls++;
          return true;
        },
      },
    } as unknown as ToolContext;
    const open = panelsTools.find((t) => t.name === "ae_open_panel")!;
    const list = panelsTools.find((t) => t.name === "ae_list_panels")!;
    await expect(open.handler({ extension_id: "x" }, ctx)).rejects.toThrow(/After Effects is rendering/);
    await expect(list.handler({}, ctx)).rejects.toThrow(/After Effects is rendering/);
    expect(cepCalls).toBe(0);
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
  });

  it("ae_ask_user still queues its question but does not ask CEP to open the panel", async () => {
    let cepCalls = 0;
    const d = deferred<unknown>();
    const r = rig({ render: () => d.promise });
    const out = await startTool(r.ctx);
    const asks = new AskStore();
    const ctx = {
      ...r.ctx,
      asks,
      cep: {
        listExtensions: () => [],
        openExtension: () => {
          cepCalls++;
          return true;
        },
      },
    } as unknown as ToolContext;
    const ask = askTools.find((t) => t.name === "ae_ask_user")!;
    const args = { question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], wait_seconds: 0 };
    await ask.handler(args, ctx);
    expect(asks.open()).toHaveLength(1);
    expect(cepCalls).toBe(0);
    d.resolve({});
    await storeFor(r.ctx).done(out.job_id);
    // After the render the panel is opened again.
    await ask.handler({ ...args, question: "Again?" }, ctx);
    expect(cepCalls).toBe(1);
  });
});

describe("the session baseline after a render", () => {
  afterEach(() => resetSessionTracking());

  it("is re-taken behind the gate, so the next write does not call the render the user's change", async () => {
    const dir = tmp();
    installSessionTracking({ dataDir: dir });
    let queued = 1;
    const snap = () => ({
      project_path: "C:/p/show.aep",
      dirty: false,
      revision: 3,
      num_items: 1,
      item_ids: [1],
      items_truncated: false,
      active_item: null,
      ae_version: "26",
      build: "1",
      render_queue: { num_items: 1, queued, rendering: 0 },
      comps: [],
    });
    const r = rig({
      snapshot: snap,
      render: async () => {
        queued = 0; // the render finished the item
        return { returned: true };
      },
    });
    const ids: string[] = [];
    const realEval = r.host.evalRaw.bind(r.host);
    (r.host as any).evalRaw = (p: any) => {
      if (String(p.label).includes("session")) ids.push(`${p.id}:${renderGate.active() ? "gated" : "open"}`);
      return realEval(p);
    };
    // A baseline from before the render: one queued item.
    getSessionTracker()!.record(snap() as any, { op_id: "op_before", tool: "ae_create_layer" });
    const out = await startTool(r.ctx);
    await storeFor(r.ctx).done(out.job_id);
    expect(ids.some((i) => /_rebase_after:gated$/.test(i))).toBe(true);
    const base = getSessionTracker()!.lastBaseline();
    expect(base?.render_queue).toMatchObject({ queued: 0 });
    expect(base?.tool).toBe("ae_render_queue_render");
  });
});

// ---------- gaps in image sequences, and the GPU ----------

describe("ae_render_queue_render: missing frames in image sequences", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  const gappy = (ageS = 3600) => {
    const first = makeSequence(path.join(tmp(), "exr"), { skip: [4, 5, 9] });
    const old = useOldFiles(ageS);
    restore = old.restore;
    return { first, old };
  };

  it("warns by default and still starts: sequence_check and a warnings line in the result", async () => {
    const { first } = gappy();
    const r = rig({ items: footagePage([{ file: first, name: "A beauty" }]) });
    const out = await startTool(r.ctx);
    expect(out).toMatchObject({ ok: true, started: true });
    expect(out.sequence_check).toMatchObject({ with_gaps: 1, checked: 1 });
    expect(out.sequence_check.sequences[0]).toMatchObject({ state: "gaps", missing: 3, missing_text: "0004-0005, 0009" });
    expect(out.warnings.join(" ")).toMatch(/1 image sequence has missing frames/);
    await storeFor(r.ctx).done(out.job_id);
    expect(r.calls.map((c) => c.fn)).toContain("rqeditRender");
  });

  it("block on a check that could not finish refuses with sequence_check_incomplete, not 'fix the missing frames'", async () => {
    const r = rig({ items: footagePage([{ file: path.join(os.tmpdir(), "chroma-no-such-folder-xyz", "A.0001.exr") }]) });
    const out = await startTool(r.ctx, { sequence_check: "block" });
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].code).toBe("sequence_check_incomplete");
    expect(out.message).toMatch(/could not finish/);
    expect(out.message).not.toMatch(/Fix the missing frames/);
    expect(out.refused[0].message).not.toMatch(/Fix the missing frames/);
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
  });

  it("block refuses before anything is created: no job, no render eval, gate open, lease free", async () => {
    const { first } = gappy();
    const r = rig({ items: footagePage([{ file: first }]) });
    const out = await startTool(r.ctx, { sequence_check: "block" });
    expect(out).toMatchObject({ ok: false, started: false });
    expect(out.refused[0].code).toBe("sequence_gaps");
    expect(out.message).toMatch(/Nothing was started/);
    expect(out.sequence_check.with_gaps).toBe(1);
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
    expect(storeFor(r.ctx).latest()).toBeUndefined();
    expect(renderGate.active()).toBeNull();
    expect(r.queue.inFlight).toBeNull();
  });

  it("off does not read the footage list or any folder", async () => {
    const { first, old } = gappy();
    const r = rig({ items: footagePage([{ file: first }]) });
    const out = await startTool(r.ctx, { sequence_check: "off" });
    expect(out.started).toBe(true);
    expect(out.sequence_check).toBeUndefined();
    expect(r.calls.map((c) => c.fn)).not.toContain("preflightItems");
    expect(old.log.readdir).toEqual([]);
    await storeFor(r.ctx).done(out.job_id);
  });

  it("block with a sequence still being written starts, and reports writing", async () => {
    const { first } = gappy(2);
    const r = rig({ items: footagePage([{ file: first }]) });
    const out = await startTool(r.ctx, { sequence_check: "block" });
    expect(out.started).toBe(true);
    expect(out.sequence_check).toMatchObject({ with_gaps: 0, writing: 1 });
    await storeFor(r.ctx).done(out.job_id);
  });

  it("a clean project adds no sequence warning", async () => {
    const first = makeSequence(path.join(tmp(), "ok"));
    const old = useOldFiles();
    restore = old.restore;
    const r = rig({ items: footagePage([{ file: first }]) });
    const out = await startTool(r.ctx);
    expect(out.started).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(out.sequence_check).toMatchObject({ checked: 1, with_gaps: 0, sequences: [] });
    await storeFor(r.ctx).done(out.job_id);
  });
});

describe("ae_render_queue_render: GPU and other renderers", () => {
  const saved = { ...resourceDeps };
  afterEach(() => {
    Object.assign(resourceDeps, saved);
    resetResourceCache();
  });
  const probe = (usedGb: number, processes: any[] = []) => {
    resetResourceCache();
    Object.assign(resourceDeps, {
      platform: () => "win32" as const,
      run: async () => ({ ok: true, adapters: [{ luid: "a", used_mb: usedGb * 1024 }], totals: [{ name: "RTX 4090", total_mb: 24 * 1024 }], processes }),
    });
  };

  it("adds resource_warnings when the card is nearly full, and still starts", async () => {
    probe(22.5, [{ pid: 41264, name: "Cinema 4D", gpu_mb: 9000 }]);
    const r = rig();
    const out = await startTool(r.ctx);
    expect(out).toMatchObject({ ok: true, started: true });
    expect(out.resource_warnings).toHaveLength(1);
    expect(out.resource_warnings[0]).toMatch(/94 % full.*Cinema 4D \(pid 41264\)/);
    expect(tool("ae_render_queue_render").description).toMatch(/If `resource_warnings` is present, tell the user before continuing/);
    await storeFor(r.ctx).done(out.job_id);
  });

  it("has no resource_warnings key when the card has room", async () => {
    probe(8);
    const r = rig();
    const out = await startTool(r.ctx);
    expect(out.started).toBe(true);
    expect("resource_warnings" in out).toBe(false);
    await storeFor(r.ctx).done(out.job_id);
  });

  it("reads the GPU before it takes the queue lease", async () => {
    let leaseHeldDuringProbe: boolean | null = null;
    const r = rig();
    resetResourceCache();
    Object.assign(resourceDeps, {
      platform: () => "win32" as const,
      run: async () => {
        leaseHeldDuringProbe = r.queue.inFlight !== null;
        return { ok: true, adapters: [], totals: [], processes: [] };
      },
    });
    const out = await startTool(r.ctx);
    expect(leaseHeldDuringProbe).toBe(false);
    await storeFor(r.ctx).done(out.job_id);
  });
});

describe("ae_render_queue_render: a footage list that cannot be read", () => {
  it("keeps the throw (its render eval would queue behind the abandoned one): nothing starts, the lease is free", async () => {
    const r = rig({ itemsFail: true });
    await expect(startTool(r.ctx)).rejects.toThrow(/panel gone/);
    expect(r.calls.map((c) => c.fn)).not.toContain("rqeditRender");
    expect(storeFor(r.ctx).latest()).toBeUndefined();
    expect(renderGate.active()).toBeNull();
    expect(r.queue.inFlight).toBeNull();
    // sequence_check off does not need the list at all
    const off = rig({ itemsFail: true });
    const out = await startTool(off.ctx, { sequence_check: "off" });
    expect(out.started).toBe(true);
    await storeFor(off.ctx).done(out.job_id);
  });
});
