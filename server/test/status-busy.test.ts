import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBusyCache } from "../src/ae-activity.js";
import { BridgeError } from "../src/host.js";
import { renderGate } from "../src/render-gate.js";
import type { ToolContext } from "../src/tools/common.js";

// The popup read of the busy report goes through listBlockingDialogs: stand in for it, so the
// test never starts PowerShell or looks at the real screen.
const popups = vi.hoisted(() => ({ list: [] as object[] }));
// importActual with a root-relative path, not importOriginal: see test/mock-ids.test.ts.
vi.mock("../src/tools/ext/dialogs.js", async () => {
  const orig = await vi.importActual<typeof import("../src/tools/ext/dialogs.js")>("/src/tools/ext/dialogs.ts");
  return { ...orig, listBlockingDialogs: async () => ({ ok: true, dialogs: popups.list }) };
});

import { readTools } from "../src/tools/read.js";

const status = readTools.find((t) => t.name === "ae_status")!;
const MIN = 60_000;

type CallHost = (fn: string, args: unknown, opts: { label: string; timeoutMs?: number }) => Promise<{ result: Record<string, unknown> }>;

function ctxWith(opts: { callHost: CallHost; serviceInfo?: () => Record<string, unknown>; withHealth?: boolean }) {
  const ctx = {
    bridge: { callHost: opts.callHost },
    queue: { inFlight: null, depth: 0 },
    quarantine: { list: () => [{ op_id: "op_q" }] },
    serviceInfo: opts.serviceInfo,
  };
  return ctx as unknown as ToolContext;
}

const neverCalled: CallHost = async () => {
  throw new Error("callHost must not be called while AE is busy");
};

beforeEach(() => {
  popups.list = [];
  resetBusyCache();
});
afterEach(() => {
  renderGate.reset();
});

describe("ae_status while After Effects is busy", () => {
  it("answers at once with ae_answered false and the reason, and never calls AE", async () => {
    popups.list = [{ handle: 7, title: "After Effects", text: "The following 1 fonts were not synced", buttons: [{ name: "OK" }, { name: "Cancel" }], caused_by_op: "op_1" }];
    const ctx = ctxWith({
      callHost: neverCalled,
      serviceInfo: () => ({ inFlight: { id: "mcp_9", label: "ae_export_mogrt", runningMs: 36 * MIN }, evalQueueDepth: 2 }),
    });
    const t0 = Date.now();
    const res = (await status.handler({}, ctx)) as Record<string, any>;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.ae_answered).toBe(false);
    expect(res.busy.cause).toBe("dialog_open");
    expect(res.busy.dialogs[0]).toMatchObject({ title: "After Effects", buttons: ["OK", "Cancel"] });
    expect(res.busy.in_flight).toEqual({ label: "ae_export_mogrt", running_ms: 36 * MIN });
    expect(res.message).toContain("a popup is open");
    expect(res.message).toContain("36 min");
    expect(res.quarantine).toEqual([{ op_id: "op_q" }]);
    expect(res.health).toEqual({ ok: true, transport: "panel" });
  });

  it("does not call AE for detail:true either", async () => {
    const ctx = ctxWith({
      callHost: neverCalled,
      serviceInfo: () => ({ inFlight: { label: "x", runningMs: 20_000 } }),
    });
    const res = (await status.handler({ detail: true }, ctx)) as Record<string, any>;
    expect(res.ae_answered).toBe(false);
    expect(res.detail).toBeUndefined();
  });

  it("with the render gate shut: keeps the rendering block and message, and says AE did not answer", async () => {
    renderGate.begin({ job_id: "job_1", op_id: "op_r", started_at: "2026-01-01T00:00:00Z" });
    const res = (await status.handler({}, ctxWith({ callHost: neverCalled }))) as Record<string, any>;
    expect(res.rendering).toMatchObject({ job_id: "job_1", state: "rendering" });
    expect(res.ae_answered).toBe(false);
    expect(res.busy.cause).toBe("rendering");
    expect(res.message).toMatch(/ae_render_queue_render_status/);
  });

  it("returns the busy shape, not an exception, when the call is refused as queued", async () => {
    const ctx = ctxWith({
      callHost: async () => {
        throw new BridgeError({ kind: "queued", message: "After Effects is busy: something" });
      },
    });
    const res = (await status.handler({}, ctx)) as Record<string, any>;
    expect(res.ae_answered).toBe(false);
    expect(res.busy.busy).toBe(true);
    expect(res.busy.cause).toBe("unknown");
    expect(res.message).toContain("Nothing was sent to AE");
  });

  it("returns the busy shape when AE does not answer within the status wait (10 s in all), saying the request was sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const ctx = ctxWith({ callHost: () => new Promise(() => {}) });
      const p = status.handler({}, ctx) as Promise<Record<string, any>>;
      await vi.advanceTimersByTimeAsync(10_001);
      const res = await p;
      expect(res.ae_answered).toBe(false);
      expect(res.message).toContain("was sent and has not been answered");
      expect(res.message).not.toContain("Nothing was sent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a callHost that itself reports a timeout gives the busy shape too (the request was sent)", async () => {
    const ctx = ctxWith({
      callHost: async () => {
        throw new BridgeError({ kind: "timeout", message: "timed out" });
      },
    });
    const res = (await status.handler({}, ctx)) as Record<string, any>;
    expect(res.ae_answered).toBe(false);
    expect(res.message).toContain("was sent and has not been answered");
  });

  it("still throws errors that are not about AE being busy", async () => {
    const ctx = ctxWith({
      callHost: async () => {
        throw new BridgeError({ kind: "evalscript_error", message: "ReferenceError" });
      },
    });
    await expect(status.handler({}, ctx)).rejects.toMatchObject({ kind: "evalscript_error" });
  });
});

describe("ae_status while After Effects is free", () => {
  it("keeps today's reply: health, the host's fields, the quarantine, and no ae_answered", async () => {
    const ctx = ctxWith({
      callHost: async () => ({ result: { project_path: "<unsaved>", dirty: false } }),
      serviceInfo: () => ({ inFlight: null, evalQueueDepth: 0 }),
    });
    const res = (await status.handler({}, ctx)) as Record<string, any>;
    expect(Object.keys(res)).toEqual(["health", "project_path", "dirty", "quarantine"]);
    expect(res.health).toEqual({ ok: true, transport: "panel" });
  });

  it("shows the service's instance block in health when it has one", async () => {
    const instance = { ae_label: "2026", pid: 123, host_path: "C:/AE" };
    const ctx = ctxWith({
      callHost: async () => ({ result: { project_path: "<unsaved>" } }),
      serviceInfo: () => ({ inFlight: null, instance }),
    });
    const res = (await status.handler({}, ctx)) as Record<string, any>;
    expect(res.health).toEqual({ ok: true, transport: "panel", instance });
  });

  it("a short eval in the service does not make AE busy", async () => {
    let called = 0;
    const ctx = ctxWith({
      callHost: async () => {
        called++;
        return { result: { project_path: "<unsaved>" } };
      },
      serviceInfo: () => ({ inFlight: { label: "ae_get_comp", runningMs: 3_000 } }),
    });
    const res = (await status.handler({}, ctx)) as Record<string, any>;
    expect(called).toBe(1);
    expect(res.ae_answered).toBeUndefined();
  });
});
