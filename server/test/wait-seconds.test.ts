import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { AerenderJobRegistry, AeAerenderStatusSchema, createAerenderTools, type AerenderJobRecord } from "../src/tools/ext/aerender.js";
import { AeRenderQueueRenderStatusSchema, resetRenderJobStores, rqrenderTools, storeFor } from "../src/tools/ext/rqrender.js";
import { clampWaitSeconds, MAX_WAIT_SECONDS, waitForChange } from "../src/wait-for-change.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-wait-"));
  resetRenderJobStores();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("waitForChange", () => {
  it("clamps the seconds to 0..30", () => {
    expect(clampWaitSeconds(undefined)).toBe(0);
    expect(clampWaitSeconds(-3)).toBe(0);
    expect(clampWaitSeconds(12)).toBe(12);
    expect(clampWaitSeconds(500)).toBe(MAX_WAIT_SECONDS);
  });

  it("answers at once for 0 seconds and sets no timer", async () => {
    const res = await waitForChange({ seconds: 0, changed: () => true });
    expect(res).toEqual({ waited_ms: 0, changed: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timer at a time and ends when the thing changes", async () => {
    let flag = false;
    const p = waitForChange({ seconds: 10, changed: () => flag });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(vi.getTimerCount()).toBe(1);
    flag = true;
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.changed).toBe(true);
    expect(res.waited_ms).toBe(3000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends at the deadline when nothing changes, never past 30 seconds", async () => {
    const p = waitForChange({ seconds: 999, changed: () => false });
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await p;
    expect(res).toEqual({ waited_ms: 30_000, changed: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes at once on a store update and removes its listener", async () => {
    let flag = false;
    let wake: (() => void) | null = null;
    let removed = 0;
    const p = waitForChange({
      seconds: 20,
      changed: () => flag,
      subscribe: (w) => {
        wake = w;
        return () => {
          removed++;
        };
      },
    });
    await vi.advanceTimersByTimeAsync(400);
    flag = true;
    wake!();
    const res = await p;
    expect(res).toEqual({ waited_ms: 400, changed: true });
    expect(removed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function rqRecord(file: string, state = "running") {
  return {
    job_id: "rqjob_w",
    op_id: "op_w",
    state,
    started_at: new Date().toISOString(),
    max_hours: 12,
    project_path: "<unsaved>",
    overwrite: false,
    items: [{ index: 1, comp_id: 5, outputs: [{ item_index: 1, comp_id: 5, module: 1, file, sequence: false }] }],
  } as any;
}

describe("ae_render_queue_render_status wait_seconds", () => {
  const status = rqrenderTools.find((t) => t.name === "ae_render_queue_render_status")!;
  const call = (ctx: ToolContext, extra: Record<string, unknown>) =>
    status.handler(AeRenderQueueRenderStatusSchema.parse({ include_dialogs: false, ...extra }), ctx) as Promise<Record<string, any>>;

  it("takes 0 to 30 and says so in the description", () => {
    expect(AeRenderQueueRenderStatusSchema.safeParse({ wait_seconds: 30 }).success).toBe(true);
    expect(AeRenderQueueRenderStatusSchema.safeParse({ wait_seconds: 31 }).success).toBe(false);
    expect(AeRenderQueueRenderStatusSchema.safeParse({ wait_seconds: -1 }).success).toBe(false);
    expect(status.description).toMatch(/wait_seconds/);
    expect(status.description).toMatch(/replaces several polls/);
  });

  it("without wait_seconds answers at once, with no waited_ms and no timer", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    storeFor(ctx).create(rqRecord(path.join(dir, "a.mov")));
    const res = await call(ctx, {});
    expect(res.state).toBe("running");
    expect(res.waited_ms).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns early when the job's state changes, and answers with the new state", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    const store = storeFor(ctx);
    store.create(rqRecord(path.join(dir, "a.mov")));
    const p = call(ctx, { wait_seconds: 20 });
    await vi.advanceTimersByTimeAsync(1500);
    store.update("rqjob_w", { state: "finished", ok: true, finished_at: new Date().toISOString() });
    const res = await p;
    expect(res.state).toBe("finished");
    expect(res.waited_ms).toBe(1500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an output file appearing does NOT end the wait for an After Effects job", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    const file = path.join(dir, "a.mov");
    storeFor(ctx).create(rqRecord(file));
    const p = call(ctx, { wait_seconds: 20 });
    await vi.advanceTimersByTimeAsync(2100);
    fs.writeFileSync(file, "x");
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(13_000);
    const res = await p;
    expect(res.state).toBe("running");
    expect(res.outputs[0]).toMatchObject({ exists: true });
    expect(res.waited_ms).toBe(20_000);
  });

  it("a restore state change ends the wait for an After Effects job", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    const store = storeFor(ctx);
    store.create({ ...rqRecord(path.join(dir, "a.mov")), restore: { state: "pending", held: [], restored: [], not_restored: [] } });
    const p = call(ctx, { wait_seconds: 20 });
    await vi.advanceTimersByTimeAsync(1000);
    store.update("rqjob_w", { restore: { state: "restored", held: [], restored: [], not_restored: [] } } as any);
    const res = await p;
    expect(res.waited_ms).toBe(1000);
  });

  it("an output file appearing ends the wait for a Media Encoder job, whose state never changes", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    const file = path.join(dir, "a.mov");
    storeFor(ctx).create({ ...rqRecord(file, "queued_in_media_encoder"), engine: "media_encoder" });
    const p = call(ctx, { wait_seconds: 20 });
    await vi.advanceTimersByTimeAsync(2100);
    fs.writeFileSync(file, "x");
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.outputs[0]).toMatchObject({ exists: true });
    expect(res.waited_ms).toBe(3000);
  });

  it("waits the full time when nothing changes", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    storeFor(ctx).create(rqRecord(path.join(dir, "a.mov")));
    const p = call(ctx, { wait_seconds: 5 });
    await vi.advanceTimersByTimeAsync(5000);
    const res = await p;
    expect(res.state).toBe("running");
    expect(res.waited_ms).toBe(5000);
  });

  it("does not wait for a job that is already over", async () => {
    const ctx = { dataDir: dir } as unknown as ToolContext;
    storeFor(ctx).create(rqRecord(path.join(dir, "a.mov"), "finished"));
    const res = await call(ctx, { wait_seconds: 20 });
    expect(res.state).toBe("finished");
    expect(res.waited_ms).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never uses the AE queue or the bridge while waiting", async () => {
    const touched: string[] = [];
    const boom = (name: string) => () => {
      touched.push(name);
      throw new Error(name);
    };
    const ctx = {
      dataDir: dir,
      bridge: { evalRaw: boom("evalRaw"), callHost: boom("callHost") },
      queue: { run: boom("queue.run"), acquire: boom("queue.acquire") },
    } as unknown as ToolContext;
    const store = storeFor(ctx);
    store.create(rqRecord(path.join(dir, "a.mov")));
    const p = call(ctx, { wait_seconds: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(touched).toEqual([]);
  });
});

function aeRecord(outputPath: string, state: AerenderJobRecord["state"] = "running"): AerenderJobRecord {
  return {
    job_id: "job_w",
    pid: 1234,
    state,
    exit_code: null,
    signal: null,
    cancelled: false,
    project_path: "C:/p.aep",
    comp_name: "Main",
    output_path: outputPath,
    aerender_path: "aerender",
    args: [],
    log_path: path.join(dir, "job_w.log"),
    started_at: new Date().toISOString(),
    finished_at: null,
  } as AerenderJobRecord;
}

describe("ae_aerender_status wait_seconds", () => {
  const mk = () => {
    const registry = new AerenderJobRegistry(path.join(dir, "jobs.json"), { cool_down_ms: 0, list_engines: () => [] });
    const tool = createAerenderTools({ registry }).find((t) => t.name === "ae_aerender_status")!;
    const call = (extra: Record<string, unknown>) => tool.handler(AeAerenderStatusSchema.parse({ job_id: "job_w", ...extra }), {} as ToolContext) as Promise<Record<string, any>>;
    return { registry, tool, call };
  };

  it("takes 0 to 30 and says so in the description", () => {
    const { tool } = mk();
    expect(AeAerenderStatusSchema.safeParse({ job_id: "j", wait_seconds: 30 }).success).toBe(true);
    expect(AeAerenderStatusSchema.safeParse({ job_id: "j", wait_seconds: 31 }).success).toBe(false);
    expect(tool.description).toMatch(/wait_seconds/);
    expect(tool.description).toMatch(/replaces several polls/);
  });

  it("without wait_seconds answers at once", async () => {
    const { registry, call } = mk();
    registry.register(aeRecord(path.join(dir, "out.mov")));
    const res = await call({});
    expect(res.state).toBe("running");
    expect(res.waited_ms).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns early when the job ends", async () => {
    const { registry, call } = mk();
    registry.register(aeRecord(path.join(dir, "out.mov")));
    const p = call({ wait_seconds: 25 });
    await vi.advanceTimersByTimeAsync(2000);
    registry.update("job_w", { state: "succeeded", exit_code: 0, finished_at: new Date().toISOString() });
    const res = await p;
    expect(res.state).toBe("succeeded");
    expect(res.waited_ms).toBe(2000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns early when the phase changes, not when the output file appears", async () => {
    const { registry, call } = mk();
    const out = path.join(dir, "out.mov");
    registry.register({ ...aeRecord(out), phase: "queued" } as AerenderJobRecord);
    const p = call({ wait_seconds: 20 });
    await vi.advanceTimersByTimeAsync(1500);
    fs.writeFileSync(out, "x");
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(1);
    registry.update("job_w", { phase: "spawned" } as any);
    const res = await p;
    expect(res.state).toBe("running");
    expect(res.waited_ms).toBe(4500);

    const q = call({ wait_seconds: 4 });
    await vi.advanceTimersByTimeAsync(4000);
    const idle = await q;
    expect(idle.waited_ms).toBe(4000);
  });

  it("does not wait for a job that is no longer running", async () => {
    const { registry, call } = mk();
    registry.register(aeRecord(path.join(dir, "out.mov"), "failed"));
    const res = await call({ wait_seconds: 20 });
    expect(res.state).toBe("failed");
    expect(res.waited_ms).toBe(0);
  });
});
