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
});
