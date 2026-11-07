import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_CHECK_AGAIN_S,
  BUSY_DIALOG_BUDGET_MS,
  BUSY_DIALOG_CACHE_MS,
  BUSY_REFUSE_AFTER_MS,
  busyError,
  classifyBusy,
  describeBusy,
  isBusyNow,
  readBusyDialogs,
  type BusyDialog,
  type BusyInput,
} from "../src/ae-activity.js";
import { renderGate } from "../src/render-gate.js";

afterEach(() => {
  renderGate.reset();
  vi.useRealTimers();
});

const MIN = 60_000;

function input(over: Partial<BusyInput> = {}): BusyInput {
  return {
    thresholdMs: BUSY_REFUSE_AFTER_MS,
    renderGate: null,
    inFlight: null,
    evalQueueDepth: 0,
    sentActive: 0,
    abandoned: 0,
    serviceIdle: false,
    queue: { holder: null, depth: 0 },
    dialogs: [],
    ...over,
  };
}

const POPUP: BusyDialog = {
  handle: 7,
  title: "After Effects",
  text: "The following 1 fonts were not synced",
  buttons: ["OK", "Cancel"],
  caused_by_op: "op_1",
};

describe("the named constants", () => {
  it("refuses after 15 s and tells callers to look again in 30 s", () => {
    expect(BUSY_REFUSE_AFTER_MS).toBe(15_000);
    expect(BUSY_CHECK_AGAIN_S).toBe(30);
  });
});

describe("classifyBusy", () => {
  it("is null when nothing is busy", () => {
    expect(classifyBusy(input())).toBeNull();
  });

  it("is null for a short eval the service has in flight (a normal 1-10 s op)", () => {
    expect(classifyBusy(input({ inFlight: { label: "ae_get_comp", runningMs: 2_000 } }))).toBeNull();
    expect(classifyBusy(input({ inFlight: { label: "x", runningMs: BUSY_REFUSE_AFTER_MS - 1 } }))).toBeNull();
  });

  it("is busy once a foreign eval has run for the threshold", () => {
    const r = classifyBusy(input({ inFlight: { label: "ae_export_mogrt", runningMs: BUSY_REFUSE_AFTER_MS } }))!;
    expect(r.busy).toBe(true);
    expect(r.cause).toBe("script_running");
    expect(r.in_flight).toEqual({ label: "ae_export_mogrt", running_ms: BUSY_REFUSE_AFTER_MS });
    expect(r.message).toContain("ae_export_mogrt");
    expect(r.message).toContain("cannot tell from outside");
    expect(r.message).toContain("Nothing was sent to AE");
    expect(r.check_again_in_s).toBe(30);
  });

  it("is not busy when the long eval is one this server is itself waiting on (it holds the lease)", () => {
    expect(classifyBusy(input({ sentActive: 1, inFlight: { label: "ae_snapshot_frame", runningMs: 40 * MIN } }))).toBeNull();
  });

  it("is busy at once when an earlier eval of ours was abandoned and still runs, even with no service info", () => {
    const r = classifyBusy(input({ abandoned: 1 }))!;
    expect(r.cause).toBe("script_running");
    expect(r.abandoned_ours).toBe(1);
    expect(r.message).toContain("timed out");
  });

  it("an abandoned count is ignored while the service says it has nothing in flight or queued", () => {
    expect(classifyBusy(input({ abandoned: 1, serviceIdle: true }))).toBeNull();
    expect(classifyBusy(input({ abandoned: 1, serviceIdle: false }))).not.toBeNull();
  });

  it("a popup alone does not make AE busy", () => {
    expect(classifyBusy(input({ dialogs: [POPUP] }))).toBeNull();
  });

  it("a popup wins over a long script and is named with its text and buttons", () => {
    const r = classifyBusy(input({ inFlight: { label: "ae_export_mogrt", runningMs: 36 * MIN }, dialogs: [POPUP] }))!;
    expect(r.cause).toBe("dialog_open");
    expect(r.message).toContain("a popup is open");
    expect(r.message).toContain("The following 1 fonts were not synced");
    expect(r.message).toContain("[OK | Cancel]");
    expect(r.message).toContain("36 min");
    expect(r.message).toContain("ae_dialogs");
    expect(r.dialogs).toEqual([POPUP]);
  });

  it("the shut render gate wins over a popup and keeps the render message", () => {
    renderGate.begin({ job_id: "job_1", op_id: "op_r", started_at: "2026-01-01T00:00:00Z" });
    const r = classifyBusy(input({ renderGate: renderGate.active(), dialogs: [POPUP], inFlight: { label: "render", runningMs: 99 * MIN } }))!;
    expect(r.cause).toBe("rendering");
    expect(r.render_gate).toEqual({ job_id: "job_1", state: "rendering" });
    expect(r.message).toContain("After Effects is rendering (job job_1");
    expect(r.message).toContain("ae_render_queue_render_status");
  });

  it("force builds an unknown-cause report when nothing explains the failure", () => {
    expect(classifyBusy(input())).toBeNull();
    const r = classifyBusy(input(), { force: true })!;
    expect(r.cause).toBe("unknown");
    expect(r.message).toContain("Nothing was sent to AE");
  });

  it("reports the queues", () => {
    const r = classifyBusy(
      input({ inFlight: { label: "a", runningMs: 20_000 }, evalQueueDepth: 3, queue: { holder: "op_z", depth: 2 } })
    )!;
    expect(r.waiting_in_service).toBe(3);
    expect(r.server_queue).toEqual({ holder: "op_z", depth: 2 });
  });

  it("uses seconds under two minutes and minutes after", () => {
    expect(classifyBusy(input({ inFlight: { label: "a", runningMs: 90_000 } }))!.message).toContain("90 s");
    expect(classifyBusy(input({ inFlight: { label: "a", runningMs: 9 * MIN } }))!.message).toContain("9 min");
  });
});

describe("readBusyDialogs", () => {
  it("clips long text to 400 characters and flattens buttons to names", async () => {
    const reader = async () => [
      { handle: 3, title: "T", text: "x".repeat(1000), buttons: [{ name: "OK" }, { name: "" }, "Cancel"], caused_by_op: null },
    ];
    const out = await readBusyDialogs(reader);
    expect(out).toHaveLength(1);
    expect(out[0].text.length).toBeLessThanOrEqual(400);
    expect(out[0].buttons).toEqual(["OK", "Cancel"]);
    expect(out[0].handle).toBe(3);
  });

  it("serves a second call from the cache without a second probe, and probes again after the window", async () => {
    let n = 0;
    let t = 1_000;
    const reader = async () => {
      n++;
      return [{ handle: n, title: "P", text: "", buttons: [] }];
    };
    const a = await readBusyDialogs(reader, () => t);
    t += BUSY_DIALOG_CACHE_MS - 1;
    const b = await readBusyDialogs(reader, () => t);
    expect(n).toBe(1);
    expect(b).toEqual(a);
    t += 2;
    const c = await readBusyDialogs(reader, () => t);
    expect(n).toBe(2);
    expect(c[0].handle).toBe(2);
  });

  it("one read serves a burst of simultaneous calls", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reader = async () => {
      n++;
      await gate;
      return [{ handle: 1, title: "P", text: "", buttons: [] }];
    };
    const calls = [readBusyDialogs(reader), readBusyDialogs(reader), readBusyDialogs(reader)];
    release();
    const all = await Promise.all(calls);
    expect(n).toBe(1);
    expect(all.every((d) => d.length === 1)).toBe(true);
  });

  it("never throws: a failing reader gives no popups", async () => {
    await expect(readBusyDialogs(async () => Promise.reject(new Error("powershell missing")))).resolves.toEqual([]);
  });

  it("gives up on a stuck reader after the budget, without cancelling it", async () => {
    vi.useFakeTimers();
    const reader = () => new Promise<object[]>(() => {});
    const p = readBusyDialogs(reader);
    await vi.advanceTimersByTimeAsync(BUSY_DIALOG_BUDGET_MS + 1);
    await expect(p).resolves.toEqual([]);
  });
});

describe("describeBusy and isBusyNow", () => {
  it("is null for a free AE and never reads popups for it", async () => {
    let reads = 0;
    const src = {
      serviceInfo: () => ({ inFlight: null, evalQueueDepth: 0 }),
      readDialogs: async () => {
        reads++;
        return [];
      },
    };
    expect(isBusyNow(src)).toBe(false);
    expect(await describeBusy(src)).toBeNull();
    expect(reads).toBe(0);
  });

  it("names the popup of a busy AE, from the injected reader", async () => {
    const src = {
      serviceInfo: () => ({ inFlight: { id: "mcp_9", label: "ae_export_mogrt", runningMs: 36 * MIN }, evalQueueDepth: 2 }),
      queue: { inFlight: null, depth: 0 },
      readDialogs: async () => [{ handle: 7, title: "After Effects", text: "fonts not synced", buttons: [{ name: "OK" }], caused_by_op: "op_1" }],
    };
    expect(isBusyNow(src)).toBe(true);
    const r = (await describeBusy(src))!;
    expect(r.cause).toBe("dialog_open");
    expect(r.dialogs[0]).toMatchObject({ title: "After Effects", text: "fonts not synced", buttons: ["OK"], caused_by_op: "op_1" });
    expect(r.waiting_in_service).toBe(2);
    const err = busyError(r, "op_x");
    expect(err.kind).toBe("queued");
    expect(err.op_id).toBe("op_x");
    expect((err.actual as { busy: { cause: string } }).busy.cause).toBe("dialog_open");
  });

  it("survives a serviceInfo that throws", async () => {
    const src = {
      serviceInfo: () => {
        throw new Error("boom");
      },
    };
    expect(isBusyNow(src)).toBe(false);
  });

  it("an abandoned eval does not refuse once the service reports itself idle", () => {
    const busyState = () => ({ sentActive: 0, abandoned: 1 });
    expect(isBusyNow({ busyState })).toBe(true); // no service info: the counter is trusted
    expect(isBusyNow({ busyState, serviceInfo: () => ({ inFlight: null, evalQueueDepth: 0 }) })).toBe(false);
    expect(isBusyNow({ busyState, serviceInfo: () => ({ inFlight: null, evalQueueDepth: 2 }) })).toBe(true);
    expect(isBusyNow({ busyState, serviceInfo: () => ({}) })).toBe(true); // the service did not say
  });

  it("respects a custom threshold", () => {
    const src = { serviceInfo: () => ({ inFlight: { label: "x", runningMs: 5_000 } }), thresholdMs: 1_000 };
    expect(isBusyNow(src)).toBe(true);
  });
});

describe("repair round: classification details", () => {
  it("an abandoned eval of ours is not busy while the service's eval has run for less than the threshold", () => {
    expect(classifyBusy(input({ abandoned: 1, inFlight: { label: "snapshot", runningMs: 5_000 } }))).toBeNull();
    expect(classifyBusy(input({ abandoned: 1, inFlight: { label: "snapshot", runningMs: BUSY_REFUSE_AFTER_MS } }))).not.toBeNull();
  });

  it("force with a long eval in flight, even one we wait on, is script_running and names it", () => {
    const r = classifyBusy(input({ sentActive: 1, inFlight: { label: "ae_export_mogrt", runningMs: 40_000 } }), { force: true })!;
    expect(r.cause).toBe("script_running");
    expect(r.message).toContain("ae_export_mogrt");
  });

  it("the wording says whether the request was sent", () => {
    expect(classifyBusy(input(), { force: true })!.message).toContain("Nothing was sent to AE");
    const sent = classifyBusy(input(), { force: true, requestSent: true })!.message;
    expect(sent).toContain("was sent and has not been answered");
    expect(sent).not.toContain("Nothing was sent");
  });
});

describe("describePopupBlock (the queue's wait guard)", () => {
  const popup = async () => [{ handle: 1, title: "AE", text: "t", buttons: [{ name: "OK" }] }];
  const long = () => ({ inFlight: { label: "x", runningMs: 40_000 } });

  it("is null without a popup, and null for a short eval even with one", async () => {
    const { describePopupBlock } = await import("../src/ae-activity.js");
    expect(await describePopupBlock({ serviceInfo: long, readDialogs: async () => [] })).toBeNull();
    expect(await describePopupBlock({ serviceInfo: () => ({ inFlight: { label: "x", runningMs: 1_000 } }), readDialogs: popup })).toBeNull();
    expect(await describePopupBlock({ serviceInfo: () => ({ inFlight: null }), readDialogs: popup })).toBeNull();
  });

  it("reports dialog_open for a popup while the service has a long eval, whoever's it is", async () => {
    const { describePopupBlock } = await import("../src/ae-activity.js");
    const r = (await describePopupBlock({ serviceInfo: long, busyState: () => ({ sentActive: 1, abandoned: 0 }), readDialogs: popup }))!;
    expect(r.cause).toBe("dialog_open");
  });
});
