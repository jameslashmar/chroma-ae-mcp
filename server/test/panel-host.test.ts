import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import {
  PanelHost,
  type PanelEvalScriptResult,
} from "../src/panel-host.js";
import {
  QuarantineBlockedError,
  QuarantineStore,
} from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { renderGate } from "../src/render-gate.js";

describe("PanelHost", () => {
  const tmpDirs: string[] = [];

  function makeTempQuarantine(): QuarantineStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-phost-"));
    tmpDirs.push(dir);
    return new QuarantineStore(path.join(dir, "quarantine.json"));
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("executes evalRaw and callHost on success", async () => {
    const calls: Array<{ script: string; label: string }> = [];
    const host = new PanelHost({
      evalScript: async (script, label) => {
        calls.push({ script, label });
        return {
          ok: true,
          result: { comp_id: 42, name: "Main Comp" },
          durationMs: 12,
        };
      },
      queue: new SingleWriterQueue(),
      quarantine: makeTempQuarantine(),
    });

    const res = await host.callHost<{ comp_id: number; name: string }>(
      "getComp",
      { comp_id: 42 },
      {
        label: "ae_get_comp(42)",
        mutates: false,
        toolName: "ae_get_comp",
      }
    );

    expect(res.result).toEqual({ comp_id: 42, name: "Main Comp" });
    expect(res.durationMs).toBe(12);
    expect(res.id).toMatch(/^op_/);
    expect(calls).toEqual([
      {
        script: '__chromaAe.getComp({"comp_id":42})',
        label: "ae_get_comp(42)",
      },
    ]);
  });

  it("maps known error kinds and normalises unknown kinds to evalscript_error", async () => {
    const guardHost = new PanelHost({
      evalScript: async () => ({
        ok: false,
        error: {
          kind: "guard",
          message: "Project path mismatch",
          expected: { project_path: "A.aep" },
          actual: { project_path: "B.aep" },
        },
      }),
    });

    await expect(
      guardHost.evalRaw({
        id: "op_guard_1",
        script: "__chromaAe.checkGuard({})",
        label: "checkGuard",
      })
    ).rejects.toThrow(BridgeError);

    try {
      await guardHost.evalRaw({
        id: "op_guard_1",
        script: "__chromaAe.checkGuard({})",
        label: "checkGuard",
      });
    } catch (err) {
      const bErr = err as BridgeError;
      expect(bErr.kind).toBe("guard");
      expect(bErr.op_id).toBe("op_guard_1");
      expect(bErr.expected).toEqual({ project_path: "A.aep" });
      expect(bErr.actual).toEqual({ project_path: "B.aep" });
    }

    const runtimeHost = new PanelHost({
      evalScript: async () => ({
        ok: false,
        error: {
          kind: "runtime",
          message: "Undefined is not an object",
          line: 17,
        },
      }),
    });

    try {
      await runtimeHost.evalRaw({
        id: "op_rt_1",
        script: "__chromaAe.runUserJsx({})",
        label: "user script",
      });
      expect.unreachable("Should have thrown BridgeError");
    } catch (err) {
      const bErr = err as BridgeError;
      expect(bErr).toBeInstanceOf(BridgeError);
      expect(bErr.kind).toBe("evalscript_error");
      expect(bErr.line).toBe(17);
      expect(bErr.op_id).toBe("op_rt_1");
      expect(bErr.message).toBe("Undefined is not an object");
    }
  });

  it("races timeout -> kind:'timeout', quarantines mutations, and never cancels the underlying evalScript promise", async () => {
    const quarantine = makeTempQuarantine();
    let resolveUnderlying!: (val: PanelEvalScriptResult) => void;
    let underlyingCompletedAfterTimeout = false;

    const underlyingPromise = new Promise<PanelEvalScriptResult>((resolve) => {
      resolveUnderlying = resolve;
    }).then((val) => {
      underlyingCompletedAfterTimeout = true;
      return val;
    });

    const host = new PanelHost({
      evalScript: () => underlyingPromise,
      quarantine,
    });

    let caughtErr: unknown;
    try {
      await host.evalRaw({
        id: "op_mut_timeout",
        script: '__chromaAe.setProperty({"comp_id":1})',
        label: "ae_set_property(Opacity)",
        timeoutMs: 25,
        mutates: true,
        toolName: "ae_set_property",
      });
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(BridgeError);
    const bErr = caughtErr as BridgeError;
    expect(bErr.kind).toBe("timeout");
    expect(bErr.op_id).toBe("op_mut_timeout");

    // Mutating operation must be placed in quarantine
    expect(quarantine.isQuarantined).toBe(true);
    expect(quarantine.get("op_mut_timeout")).toMatchObject({
      op_id: "op_mut_timeout",
      tool: "ae_set_property",
      label: "ae_set_property(Opacity)",
    });

    // Subsequent mutations via callHost must be refused by quarantine before calling evalScript
    await expect(
      host.callHost(
        "setProperty",
        { comp_id: 1 },
        { label: "second mutation", mutates: true, toolName: "ae_set_property" }
      )
    ).rejects.toThrow(QuarantineBlockedError);

    // Underlying promise is still pending and was NOT cancelled; resolving it now runs to completion
    expect(underlyingCompletedAfterTimeout).toBe(false);
    resolveUnderlying({ ok: true, result: { updated: true }, durationMs: 60 });
    const finalResult = await underlyingPromise;
    expect(underlyingCompletedAfterTimeout).toBe(true);
    expect(finalResult).toEqual({
      ok: true,
      result: { updated: true },
      durationMs: 60,
    });
  });

  it("does not quarantine read-only operations on timeout", async () => {
    const quarantine = makeTempQuarantine();
    const host = new PanelHost({
      evalScript: () => new Promise<PanelEvalScriptResult>(() => {}),
      quarantine,
    });

    await expect(
      host.evalRaw({
        id: "op_read_timeout",
        script: "__chromaAe.getProject({})",
        label: "ae_get_project",
        timeoutMs: 20,
        mutates: false,
        toolName: "ae_get_project",
      })
    ).rejects.toMatchObject({
      kind: "timeout",
      op_id: "op_read_timeout",
    });

    expect(quarantine.isQuarantined).toBe(false);
  });

  describe("the busy door (AE cannot answer)", () => {
    const MIN = 60_000;
    const noPopups = () => async () => [] as object[];
    const settle = () => new Promise((r) => setImmediate(r));

    function stuckHost(over: { runningMs?: number; quarantine?: QuarantineStore; busyDialogs?: () => Promise<object[]> } = {}) {
      const calls: string[] = [];
      const quarantine = over.quarantine ?? makeTempQuarantine();
      const host = new PanelHost({
        evalScript: (script) => {
          calls.push(script);
          return new Promise<PanelEvalScriptResult>(() => {});
        },
        queue: new SingleWriterQueue(),
        quarantine,
        serviceInfo: () => ({ inFlight: { id: "mcp_1", label: "ae_export_mogrt", runningMs: over.runningMs ?? 40 * MIN }, evalQueueDepth: 1 }),
        busyDialogs: over.busyDialogs ?? noPopups(),
      });
      return { host, calls, quarantine };
    }

    it("refuses a write at once when the service has had something in flight for 40 min: nothing sent, nothing quarantined", async () => {
      const { host, calls, quarantine } = stuckHost();
      const t0 = Date.now();
      const err = (await host
        .callHost("setProperty", { comp_id: 1 }, { label: "ae_set_property", mutates: true, toolName: "ae_set_property" })
        .catch((e) => e)) as BridgeError;
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.kind).toBe("queued");
      expect(calls).toHaveLength(0);
      expect(quarantine.list()).toEqual([]);
      expect(quarantine.isQuarantined).toBe(false);
      const busy = (err.actual as { busy: { cause: string; in_flight: { label: string } } }).busy;
      expect(busy.cause).toBe("script_running");
      expect(busy.in_flight.label).toBe("ae_export_mogrt");
      expect(err.message).toContain("Nothing was sent to AE");
      expect(host.busyState()).toEqual({ sentActive: 0, abandoned: 0 });
    });

    it("refuses reads too", async () => {
      const { host, calls } = stuckHost();
      await expect(host.callHost("getProject", {}, { label: "ae_get_project", mutates: false })).rejects.toMatchObject({ kind: "queued" });
      expect(calls).toHaveLength(0);
    });

    it("sends the call as before when the service eval is short", async () => {
      const { host, calls } = stuckHost({ runningMs: 2_000 });
      // The eval never answers; a short timeout ends the test. It was sent, which is the point.
      await expect(host.callHost("getProject", {}, { label: "ae_get_project", mutates: false, timeoutMs: 20 })).rejects.toMatchObject({
        kind: "timeout",
      });
      expect(calls).toHaveLength(1);
    });

    it("an eval of ours that timed out and still runs refuses the next calls at once; they go again when it finishes", async () => {
      const calls: string[] = [];
      const resolvers: Array<(v: PanelEvalScriptResult) => void> = [];
      const quarantine = makeTempQuarantine();
      const host = new PanelHost({
        evalScript: (script) => {
          calls.push(script);
          return new Promise<PanelEvalScriptResult>((resolve) => resolvers.push(resolve));
        },
        queue: new SingleWriterQueue(),
        quarantine,
        busyDialogs: noPopups(),
      });
      await expect(host.callHost("getProject", {}, { label: "first", mutates: false, timeoutMs: 30 })).rejects.toMatchObject({ kind: "timeout" });
      expect(host.busyState()).toEqual({ sentActive: 0, abandoned: 1 });

      const second = (await host
        .callHost("getProject", {}, { label: "second", mutates: true, toolName: "ae_set_property" })
        .catch((e) => e)) as BridgeError;
      expect(second.kind).toBe("queued");
      expect((second.actual as { busy: { abandoned_ours: number } }).busy.abandoned_ours).toBe(1);
      expect(calls).toHaveLength(1);
      expect(quarantine.list()).toEqual([]);

      // AE finishes the old eval: the next call is sent.
      resolvers[0]({ ok: true, result: {}, durationMs: 1 });
      await settle();
      expect(host.busyState()).toEqual({ sentActive: 0, abandoned: 0 });
      const third = host.callHost("getProject", {}, { label: "third", mutates: false });
      await settle();
      expect(calls).toHaveLength(2);
      resolvers[1]({ ok: true, result: { ok: 1 }, durationMs: 1 });
      await expect(third).resolves.toMatchObject({ result: { ok: 1 } });
    });

    it("does not refuse while it is itself waiting on the long eval the service shows", async () => {
      const calls: string[] = [];
      const host = new PanelHost({
        evalScript: (script) => {
          calls.push(script);
          return new Promise<PanelEvalScriptResult>(() => {});
        },
        // The service shows the long eval only once ours has been sent: it is ours.
        serviceInfo: () => ({ inFlight: calls.length > 0 ? { label: "ours", runningMs: 40 * MIN } : null }),
        busyDialogs: noPopups(),
      });
      void host.evalRaw({ id: "op_a", script: "a", label: "a", timeoutMs: 60_000 }).catch(() => {});
      await settle();
      void host.evalRaw({ id: "op_b", script: "b", label: "b", timeoutMs: 60_000 }).catch(() => {});
      await settle();
      expect(calls).toEqual(["a", "b"]);
      expect(host.busyState().sentActive).toBe(2);
    });

    it("puts the popups an injected reader finds into actual.busy.dialogs, text clipped", async () => {
      const reader = async () => [
        { handle: 7, title: "After Effects", text: "t".repeat(900), buttons: [{ name: "OK" }, { name: "Cancel" }], caused_by_op: "op_9" },
      ];
      const { host } = stuckHost({ busyDialogs: reader });
      const err = (await host.callHost("getProject", {}, { label: "x", mutates: false }).catch((e) => e)) as BridgeError;
      const busy = (err.actual as { busy: { cause: string; dialogs: Array<{ title: string; text: string; buttons: string[] }> } }).busy;
      expect(busy.cause).toBe("dialog_open");
      expect(busy.dialogs[0].title).toBe("After Effects");
      expect(busy.dialogs[0].text.length).toBeLessThanOrEqual(400);
      expect(busy.dialogs[0].buttons).toEqual(["OK", "Cancel"]);
      expect(err.message).toContain("[OK | Cancel]");
    });

    it("lets the render's own evals through (the render gate has its own door)", async () => {
      const { host, calls } = stuckHost();
      renderGate.begin({ job_id: "job_1", op_id: "op_render", started_at: "now" });
      try {
        void host.evalRaw({ id: "op_render_result", script: "r", label: "render result", timeoutMs: 60_000 }).catch(() => {});
        await settle();
        expect(calls).toEqual(["r"]);
        // Anything else is still refused, by the gate.
        await expect(host.evalRaw({ id: "op_other", script: "o", label: "o" })).rejects.toMatchObject({ kind: "queued" });
      } finally {
        renderGate.reset();
      }
    });

    it("never cancels an eval: the abandoned promise is only observed", async () => {
      let resolveIt!: (v: PanelEvalScriptResult) => void;
      const pending = new Promise<PanelEvalScriptResult>((r) => (resolveIt = r));
      let evals = 0;
      const host = new PanelHost({
        evalScript: () => {
          evals++;
          return pending;
        },
        busyDialogs: noPopups(),
      });
      await expect(host.evalRaw({ id: "op_1", script: "s", label: "l", timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
      await expect(host.evalRaw({ id: "op_2", script: "s", label: "l" })).rejects.toMatchObject({ kind: "queued" });
      expect(evals).toBe(1);
      resolveIt({ ok: true, result: 1, durationMs: 1 });
      await settle();
      expect(host.busyState().abandoned).toBe(0);
      // The promise AE never answered resolved by itself and the host took it as an ordinary answer.
      await expect(host.evalRaw({ id: "op_3", script: "s", label: "l" })).resolves.toMatchObject({ ok: true, result: 1 });
    });
  });
});
