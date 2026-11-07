/**
 * The busy door together with the parts it sits among: a real SingleWriterQueue lease, a real
 * PanelHost, runGuardedWrite, ae_status, and a fake panel service that behaves like service.js
 * (one eval in flight, the rest queued behind it, a stuck eval that never answers). Isolated fakes
 * of each part missed every one of these.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { renderGate } from "../src/render-gate.js";
import { readTools } from "../src/tools/read.js";
import { runGuardedWrite } from "../src/tools/ext/write-runner.js";

const status = readTools.find((t) => t.name === "ae_status")!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const THRESHOLD_MS = 150;
const tmpDirs: string[] = [];

beforeEach(() => renderGate.reset());
afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** service.js in miniature: one eval in flight, the rest queued; a negative duration never answers. */
function fakeService(dur: (fn: string) => number) {
  const queue: Array<{ fn: string; label: string; resolve: (v: unknown) => void }> = [];
  let inFlight: { label: string; startedAt: number } | null = null;
  const log: string[] = [];
  const pump = (): void => {
    if (inFlight || !queue.length) return;
    const it = queue.shift()!;
    inFlight = { label: it.label, startedAt: Date.now() };
    log.push("start " + it.fn);
    const d = dur(it.fn);
    if (d < 0) return;
    setTimeout(() => {
      inFlight = null;
      log.push("end " + it.fn);
      it.resolve({ ok: true, result: fakeResult(it.fn), durationMs: d });
      pump();
    }, d);
  };
  return {
    log,
    evalScript: (script: string, label: string) =>
      new Promise<any>((resolve) => {
        const fn = /__chromaAe\.(\w+)\(/.exec(script)?.[1] ?? script;
        queue.push({ fn, label, resolve });
        pump();
      }),
    serviceInfo: () => ({
      inFlight: inFlight ? { id: "x", label: inFlight.label, runningMs: Date.now() - inFlight.startedAt } : null,
      evalQueueDepth: queue.length,
    }),
  };
}

function fakeResult(fn: string): unknown {
  if (fn === "checkGuard") return { ok: true, project_path: "<unsaved>", dirty: false };
  if (fn === "status") return { project_path: "<unsaved>", dirty: false };
  if (fn === "probeRead") return { value: 1 };
  return { ok: 1 };
}

const POPUP = { handle: 7, title: "After Effects", text: "fonts were not synced", buttons: [{ name: "OK" }, { name: "Cancel" }], caused_by_op: "op_1" };

function world(dur: (fn: string) => number, opts: { popups?: object[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-busy-"));
  tmpDirs.push(dir);
  const svc = fakeService(dur);
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const screenshots = { n: 0 };
  const host = new PanelHost({
    evalScript: svc.evalScript,
    queue,
    quarantine,
    serviceInfo: svc.serviceInfo,
    busyThresholdMs: THRESHOLD_MS,
    busyDialogs: async () => opts.popups ?? [],
    // The timeout branch reads popups with a screenshot: counted, so a test can say it never ran.
    describeDialogs: async () => {
      screenshots.n++;
      return [];
    },
  });
  const ctx: any = {
    bridge: host,
    queue,
    quarantine,
    dataDir: dir,
    serviceInfo: svc.serviceInfo,
    settings: { get: () => ({ auto_checkpoint: { enabled: false } }) },
  };
  return { svc, host, ctx, queue, quarantine, screenshots };
}

const stuckEval = (w: ReturnType<typeof world>, timeoutMs = 60_000) =>
  w.queue
    .run("ae_export_mogrt", () => w.host.evalRaw({ id: "op_stuck", script: "__chromaAe.stuck({})", label: "ae_export_mogrt", timeoutMs }))
    .catch(() => {});

const spec = (extra: object = {}): any => ({
  toolName: "ae_probe_write",
  label: "ae_probe_write",
  expect: { project_path: "<unsaved>" },
  read: () => ({ host: "probeRead", args: {} }),
  write: { host: "probeWrite", args: {} },
  ...extra,
});

describe("our own eval is stuck inside AE (a popup, a long script) and a lease is held", () => {
  it("ae_status answers at once with the reason and never waits behind the lease", async () => {
    const w = world((fn) => (fn === "stuck" ? -1 : 1));
    void stuckEval(w);
    await sleep(THRESHOLD_MS + 100);
    const t0 = Date.now();
    const r: any = await status.handler({}, w.ctx);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.ae_answered).toBe(false);
    expect(r.busy.cause).toBe("script_running");
    expect(r.busy.in_flight.label).toBe("ae_export_mogrt");
    expect(r.message).toContain("ae_export_mogrt");
    expect(w.svc.log).not.toContain("start status");
    expect(w.queue.depth).toBe(0); // it did not join the queue
  });

  it("ae_status names the popup when one is open", async () => {
    const w = world((fn) => (fn === "stuck" ? -1 : 1), { popups: [POPUP] });
    void stuckEval(w);
    await sleep(THRESHOLD_MS + 100);
    const r: any = await status.handler({}, w.ctx);
    expect(r.ae_answered).toBe(false);
    expect(r.busy.cause).toBe("dialog_open");
    expect(r.busy.dialogs[0]).toMatchObject({ title: "After Effects", buttons: ["OK", "Cancel"] });
  });

  it("another tool call that would wait for the lease is refused at once while a popup is open", async () => {
    const w = world((fn) => (fn === "stuck" ? -1 : 1), { popups: [POPUP] });
    void stuckEval(w);
    await sleep(THRESHOLD_MS + 100);
    const t0 = Date.now();
    const err: any = await w.host.callHost("getProject", {}, { label: "ae_get_project", mutates: false }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.kind).toBe("queued");
    expect(err.actual.busy.cause).toBe("dialog_open");
    expect(w.svc.log).not.toContain("start getProject");
    expect(w.queue.depth).toBe(0);
    expect(w.quarantine.list()).toEqual([]);
  });

  it("a write that would wait is refused the same way, and is not quarantined", async () => {
    const w = world((fn) => (fn === "stuck" ? -1 : 1), { popups: [POPUP] });
    void stuckEval(w);
    await sleep(THRESHOLD_MS + 100);
    const err: any = await w.host
      .callHost("setProperty", {}, { label: "ae_set_property", mutates: true, toolName: "ae_set_property" })
      .catch((e) => e);
    expect(err.kind).toBe("queued");
    expect(w.quarantine.list()).toEqual([]);
    expect(w.svc.log).not.toContain("start setProperty");
  });

  it("a long but legitimate operation with no popup keeps its place: the next call waits and then runs", async () => {
    const w = world((fn) => (fn === "slow" ? 500 : 1));
    void w.queue.run("ae_snapshot_frame", () => w.host.evalRaw({ id: "op_slow", script: "__chromaAe.slow({})", label: "ae_snapshot_frame", timeoutMs: 5000 }));
    await sleep(THRESHOLD_MS + 100);
    const res = await w.host.callHost("getProject", {}, { label: "ae_get_project", mutates: false });
    expect(res.result).toBeTruthy();
    expect(w.svc.log).toEqual(["start slow", "end slow", "start getProject", "end getProject"]);
  });
});

describe("evals with short limits on a healthy but slow AE", () => {
  it("a guarded write goes on although an earlier short-limit read is still running in AE", async () => {
    const w = world((fn) => (fn === "slowRead" ? 100 : 1));
    // Stands in for the session snapshot (8 s limit) timing out on a slow project: AE is healthy and answers a bit later.
    const first = await w.host.evalRaw({ id: "op_snap", script: "__chromaAe.slowRead({})", label: "snapshot", timeoutMs: 20 }).catch((e) => e.kind);
    expect(first).toBe("timeout");
    expect(w.host.busyState().abandoned).toBe(1);
    const out: any = await runGuardedWrite(w.ctx, spec());
    expect(out.applied).toBe(true);
    expect(w.svc.log.filter((l) => l === "start probeWrite")).toHaveLength(1);
    expect(w.quarantine.list()).toEqual([]);
  });

  it("the next pass of a multi-pass tool is not refused although pass 1 was applied", async () => {
    const w = world((fn) => (fn === "slowRead" ? 100 : 1));
    await w.host.evalRaw({ id: "op_a", script: "__chromaAe.slowRead({})", label: "ae_status", timeoutMs: 20 }).catch(() => {});
    const pass = (n: number) => runGuardedWrite(w.ctx, spec({ label: `pass ${n}` }));
    const r1: any = await pass(1);
    const r2: any = await pass(2);
    expect([r1.applied, r2.applied]).toEqual([true, true]);
  });

  it("an abandoned eval does refuse once the service really has had something running for the threshold", async () => {
    const w = world((fn) => (fn === "stuck" ? -1 : 1));
    await w.host.evalRaw({ id: "op_x", script: "__chromaAe.stuck({})", label: "ae_export_mogrt", timeoutMs: 20 }).catch(() => {});
    await sleep(THRESHOLD_MS + 100);
    const err: any = await w.host.callHost("getProject", {}, { label: "x", mutates: false }).catch((e) => e);
    expect(err.kind).toBe("queued");
    expect(w.svc.log).toEqual(["start stuck"]);
  });
});

describe("the read-back of a write that returned", () => {
  it("is sent even when something long has appeared in AE since (no false mismatch)", async () => {
    const w = world((fn) => (fn === "foreign" ? -1 : 1));
    await w.host.evalRaw({ id: "op_w", script: "__chromaAe.probeWrite({})", label: "w", mutates: true, toolName: "t" });
    // Someone else's script now holds AE for longer than the threshold.
    void w.svc.evalScript("__chromaAe.foreign({})", "someone else");
    await sleep(THRESHOLD_MS + 100);
    const back = await w.host.evalRaw({ id: "op_w_after", script: "__chromaAe.probeRead({})", label: "read-back", timeoutMs: 80 }).catch((e) => e);
    expect(back.kind).toBe("timeout"); // it was sent (and AE did not answer), not refused as "queued"
    expect(w.svc.log).toContain("start foreign");
  });

  it("without a write before it, the same read is refused", async () => {
    const w = world((fn) => (fn === "foreign" ? -1 : 1));
    void w.svc.evalScript("__chromaAe.foreign({})", "someone else");
    await sleep(THRESHOLD_MS + 100);
    const back = await w.host.evalRaw({ id: "op_r", script: "__chromaAe.probeRead({})", label: "read", timeoutMs: 80 }).catch((e) => e);
    expect(back.kind).toBe("queued");
  });

  it("but a second write is still refused", async () => {
    const w = world((fn) => (fn === "foreign" ? -1 : 1));
    await w.host.evalRaw({ id: "op_w", script: "__chromaAe.probeWrite({})", label: "w", mutates: true, toolName: "t" });
    void w.svc.evalScript("__chromaAe.foreign({})", "someone else");
    await sleep(THRESHOLD_MS + 100);
    const again = await w.host.evalRaw({ id: "op_w2", script: "__chromaAe.probeWrite({})", label: "w2", mutates: true, toolName: "t" }).catch((e) => e);
    expect(again.kind).toBe("queued");
  });
});

describe("cleanup evals after a timed-out capture", () => {
  it("a mustSend cleanup reaches the bridge; the same eval without it is refused", async () => {
    const w = world((fn) => (fn === "capture" ? -1 : 1));
    const cap = await w.host.evalRaw({ id: "op_cap", script: "__chromaAe.capture({})", label: "capture", timeoutMs: 20 }).catch((e) => e.kind);
    expect(cap).toBe("timeout");
    await sleep(THRESHOLD_MS + 100);

    const refused = await w.host.evalRaw({ id: "op_rm1", script: "__chromaAe.explainProofEnd({})", label: "remove copy", mutates: true, toolName: "t", timeoutMs: 50 }).catch((e) => e.kind);
    expect(refused).toBe("queued");

    const sent = await w.host
      .evalRaw({ id: "op_rm2", script: "__chromaAe.explainProofEnd({})", label: "remove copy", mutates: true, mustSend: true, toolName: "t", timeoutMs: 50 })
      .catch((e) => e.kind);
    expect(sent).toBe("timeout"); // sent; AE is stuck behind the capture, so it did not answer in time
    expect(w.svc.log).toEqual(["start capture"]); // queued in the service behind the capture, which is where AE will pick it up
    expect(w.svc.serviceInfo().evalQueueDepth).toBe(1);
  });

  it("every cleanup site passes mustSend", () => {
    const root = path.resolve(__dirname, "../src/tools/ext");
    const sites: Array<[string, RegExp]> = [
      ["explain.ts", /explainProofEnd[\s\S]{0,300}mustSend: true/],
      ["legibility.ts", /legibilityEnd[\s\S]{0,300}mustSend: true/],
      ["patchcheck.ts", /patchcheckEnd[\s\S]{0,300}mustSend: true/],
      ["planar.ts", /planarIsolateEnd[\s\S]{0,300}mustSend: true/],
      ["collect.ts", /label: "Reopen the original project" \},\s*true,\s*true\s*\)/],
      ["collect.ts", /label: "Reopen the original project \(copy not saved\)" \},\s*true,\s*true\s*\)/],
      ["collect.ts", /host<ProjectState>\("collectState", \{\}, false, true\)/],
    ];
    for (const [file, re] of sites) expect(fs.readFileSync(path.join(root, file), "utf8"), `${file} ${re}`).toMatch(re);
  });
});

describe("ae_status when its own status eval is the one that does not answer", () => {
  it("says the request was sent, writes no screenshot, and returns after the wait, not after the lease and the timeouts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The service never answers anything, but only starts to count it as long after the threshold of this test.
    const w = world(() => -1);
    const p = status.handler({}, w.ctx) as Promise<any>;
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await p;
    vi.useRealTimers();
    expect(r.ae_answered).toBe(false);
    expect(r.message).toContain("was sent and has not been answered");
    expect(r.message).not.toContain("Nothing was sent");
    expect(w.screenshots.n).toBe(0);
  });

  it("does not take the lease wait plus the status limit when another tool holds the lease", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = world((fn) => (fn === "stuck" ? -1 : 1));
    // A lease holder that has not yet reached the threshold (the service clock is real time).
    void w.queue.run("holder", () => w.host.evalRaw({ id: "op_h", script: "__chromaAe.stuck({})", label: "holder", timeoutMs: 600_000 })).catch(() => {});
    const t0 = Date.now();
    const p = status.handler({}, w.ctx) as Promise<any>;
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await p;
    vi.useRealTimers();
    expect(Date.now() - t0).toBeLessThan(3000); // real time: the 10 s were fake
    expect(r.ae_answered).toBe(false);
    expect(w.screenshots.n).toBe(0);
  });
});

describe("our own eval is stuck inside AE and NO lease is held (asset watcher, footage read, diagnostics)", () => {
  const leaseless = (w: ReturnType<typeof world>) =>
    w.host.evalRaw({ id: "op_nolease", script: "__chromaAe.stuck({})", label: "asset watch status", mutates: false, timeoutMs: 60_000 }).catch(() => {});

  it("behind an open popup, the next call is refused at the door at once and a write is not quarantined", async () => {
    const w = world((fn) => (fn === "stuck" ? -1 : 1), { popups: [POPUP] });
    void leaseless(w);
    await sleep(THRESHOLD_MS + 100);
    const t0 = Date.now();
    const err: any = await w.host
      .evalRaw({ id: "op_next", script: "__chromaAe.probeWrite({})", label: "ae_probe_write", mutates: true, timeoutMs: 60_000 })
      .catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.kind).toBe("queued");
    expect(err.actual.busy.cause).toBe("dialog_open");
    expect(w.quarantine.list()).toEqual([]);
    expect(w.svc.log).not.toContain("start probeWrite");
  });

  it("a long operation with no popup keeps its place: the next call is not refused, it waits", async () => {
    const w = world((fn) => (fn === "stuck" ? THRESHOLD_MS + 400 : 1), { popups: [] });
    void leaseless(w);
    await sleep(THRESHOLD_MS + 100);
    const r = await w.host.evalRaw({ id: "op_next2", script: "__chromaAe.probeRead({})", label: "probe", mutates: false, timeoutMs: 60_000 });
    expect(r.result).toEqual({ value: 1 });
  });
});
