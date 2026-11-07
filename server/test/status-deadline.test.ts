/**
 * ae_status answers within 10 s on every path, measured on a faked clock: the popup read, the status eval, the
 * detail eval and the GPU read each get a share of the one deadline. Also the lease-less case: an eval of ours
 * stuck behind a popup without a lease makes ae_status (and the door) say busy; a long operation with no popup does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBusyCache } from "../src/ae-activity.js";
import { renderGate } from "../src/render-gate.js";
import { resetResourceCache, resourceDeps } from "../src/system-resources.js";
import type { ToolContext } from "../src/tools/common.js";
import { readTools } from "../src/tools/read.js";

const status = readTools.find((t) => t.name === "ae_status")!;
const hang = () => new Promise<never>(() => {});
const MIN = 60_000;

function ctxWith(o: {
  callHost: (fn: string) => Promise<{ result: Record<string, unknown> }>;
  serviceInfo?: () => Record<string, unknown>;
  reader?: () => Promise<object[]>;
  health?: () => Promise<unknown>;
  sentActive?: number;
  lease?: string | null;
}): ToolContext {
  return {
    bridge: {
      callHost: o.callHost,
      ...(o.health ? { health: o.health } : {}),
      busyState: () => ({ sentActive: o.sentActive ?? 0, abandoned: 0 }),
      busyThreshold: () => 15_000,
      busyDialogReader: () => o.reader,
    },
    queue: { inFlight: o.lease ?? null, depth: 0 },
    quarantine: { list: () => [] },
    serviceInfo: o.serviceInfo,
  } as unknown as ToolContext;
}

/** Runs the handler on a faked clock and returns how long (faked) it took, with its result. */
async function timed(args: Record<string, unknown>, ctx: ToolContext): Promise<{ ms: number; res: Record<string, any> }> {
  const start = Date.now();
  let end = -1;
  let res: Record<string, any> = {};
  const p = (status.handler(args, ctx) as Promise<Record<string, any>>).then((r) => {
    end = Date.now();
    res = r;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.advanceTimersByTimeAsync(0);
  await p;
  return { ms: end - start, res };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetBusyCache();
  resetResourceCache();
});
afterEach(() => {
  vi.useRealTimers();
  renderGate.reset();
  resetResourceCache();
});

describe("ae_status: at most 10 s on every path", () => {
  it("busy from the start, the popup read and /health both hang", async () => {
    const reader = hang;
    resetBusyCache(reader);
    const ctx = ctxWith({ callHost: hang, reader, health: hang, serviceInfo: () => ({ inFlight: { label: "x", runningMs: 36 * MIN } }) });
    const { ms, res } = await timed({}, ctx);
    expect(res.ae_answered).toBe(false);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("the status eval never answers, the popup read and /health hang", async () => {
    const reader = hang;
    resetBusyCache(reader);
    const ctx = ctxWith({ callHost: hang, reader, health: hang, serviceInfo: () => ({ inFlight: null, evalQueueDepth: 0 }) });
    const { ms, res } = await timed({}, ctx);
    expect(res.ae_answered).toBe(false);
    expect(ms).toBeLessThanOrEqual(10_000);
    expect(ms).toBeGreaterThanOrEqual(5_900); // it did wait for the eval first
  });

  it("detail:true: the status eval answers late, the detail eval and the GPU probe hang", async () => {
    resourceDeps.run = hang;
    const ctx = ctxWith({
      callHost: (fn) => (fn === "status" ? new Promise((ok) => setTimeout(() => ok({ result: { project_path: "<unsaved>" } }), 5_900)) : hang()),
      serviceInfo: () => ({ inFlight: null, evalQueueDepth: 0 }),
    });
    const { ms, res } = await timed({ detail: true }, ctx);
    expect(res.project_path).toBe("<unsaved>");
    expect(res.detail.error).toMatch(/detail read/);
    expect(res.detail.resources).toMatchObject({ supported: false });
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("detail:true with a fast status eval and a hanging GPU probe is still bounded", async () => {
    resourceDeps.run = hang;
    const ctx = ctxWith({
      callHost: async (fn) => ({ result: fn === "status" ? { project_path: "<unsaved>" } : { active_item: null } }),
      serviceInfo: () => ({ inFlight: null, evalQueueDepth: 0 }),
    });
    const { ms, res } = await timed({ detail: true }, ctx);
    expect(res.detail.active_item).toBeNull();
    expect(res.detail.resources).toMatchObject({ supported: false });
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("our own tool holds the lease behind a popup, the popup read hangs", async () => {
    const reader = hang;
    resetBusyCache(reader);
    const ctx = ctxWith({ callHost: hang, reader, health: hang, sentActive: 1, lease: "op_lease", serviceInfo: () => ({ inFlight: { label: "x", runningMs: 20_000 } }) });
    const { ms, res } = await timed({}, ctx);
    expect(res.ae_answered).toBe(false);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});

describe("ae_status: time already spent comes off the eval's wait", () => {
  it("a lease-less eval in flight 20 s, the popup read hangs, then the status eval hangs: still within 10 s", async () => {
    const reader = hang;
    resetBusyCache(reader);
    const ctx = ctxWith({ callHost: hang, reader, health: hang, sentActive: 1, lease: null, serviceInfo: () => ({ inFlight: { label: "asset watch status", runningMs: 20_000 }, evalQueueDepth: 0 }) });
    const { ms, res } = await timed({}, ctx);
    expect(res.ae_answered).toBe(false);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("the same with detail:true and a hanging GPU probe", async () => {
    const reader = hang;
    resetBusyCache(reader);
    resourceDeps.run = hang;
    const ctx = ctxWith({ callHost: hang, reader, health: hang, sentActive: 1, lease: null, serviceInfo: () => ({ inFlight: { label: "asset watch status", runningMs: 20_000 }, evalQueueDepth: 0 }) });
    const { ms } = await timed({ detail: true }, ctx);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("a late reply says the request was sent only when the status eval holds the lease", async () => {
    const idle = () => ({ inFlight: null, evalQueueDepth: 0 });
    const behind = await timed({}, ctxWith({ callHost: hang, health: hang, lease: "ae_get_comp", serviceInfo: idle }));
    expect(behind.res.ae_answered).toBe(false);
    expect(behind.res.message).toContain("Nothing was sent");
    resetBusyCache();
    const mine = await timed({}, ctxWith({ callHost: hang, health: hang, lease: "ae_status", serviceInfo: idle }));
    expect(mine.res.message).toContain("was sent and has not been answered");
  });
});

describe("an eval of ours without a lease", () => {
  const info = () => ({ inFlight: { label: "asset watch status", runningMs: 20_000 }, evalQueueDepth: 0 });

  it("behind an open popup: ae_status says busy at once, without sending", async () => {
    const reader = async () => [{ handle: 3, title: "After Effects", text: "A font is missing", buttons: ["OK"] }];
    resetBusyCache(reader);
    const ctx = ctxWith({ callHost: async () => { throw new Error("must not be sent"); }, reader, sentActive: 1, lease: null, serviceInfo: info });
    const { res, ms } = await timed({}, ctx);
    expect(res.ae_answered).toBe(false);
    expect(res.busy.cause).toBe("dialog_open");
    expect(ms).toBeLessThan(1000);
  });

  it("a long operation with no popup is waited for: ae_status goes on to ask AE", async () => {
    const reader = async () => [];
    resetBusyCache(reader);
    let asked = 0;
    const ctx = ctxWith({ callHost: async () => (asked++, { result: { project_path: "<unsaved>" } }), reader, sentActive: 1, lease: null, serviceInfo: info });
    const { res } = await timed({}, ctx);
    expect(asked).toBe(1);
    expect(res.ae_answered).toBeUndefined();
  });
});
