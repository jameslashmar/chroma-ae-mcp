/**
 * Write outcomes: a failed write says whether it changed the project ("not_applied") or may be
 * part-way in ("unknown"), with what to do next, and a successful one says "applied" / "no_op".
 * The host side runs core.jsx under node:vm against the simulated AE DOM.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError, bridgeErrorFromHost, withOutcome } from "../src/host.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeBatchSetSchema, productionTools } from "../src/tools/ext/production.js";
import { runGuardedWrite } from "../src/tools/ext/write-runner.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A panel whose evalScript answers per host function; `fail` returns the error envelope for one. */
function fakeAe(answer: (fn: string, script: string) => { ok: true; result: unknown } | { ok: false; error: Record<string, unknown> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-outcome-"));
  tmpDirs.push(dir);
  const calls: string[] = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      calls.push(fn);
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      const a = answer(fn, script);
      return a.ok ? { ok: true, result: a.result, durationMs: 1 } : { ok: false, error: a.error as never };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, calls };
}

const spec = { toolName: "ae_test_write", label: "Test write", expect: { project_path: "<unsaved>" }, write: { host: "testWrite", args: {} } };

describe("core.jsx reports whether a call touched the project", () => {
  function core() {
    return loadHost(new FakeProject(), []).A;
  }

  it("an error before any undo group is untouched", () => {
    const A = core();
    A.beginCall();
    expect(A.formatError(new Error("bad layer"))).toMatchObject({ message: "bad layer", touched: false });
  });

  it("an error inside an undo group is touched, and the next call starts clean", () => {
    const A = core();
    A.beginCall();
    let caught: unknown;
    try {
      A.withUndo("x", () => {
        throw new Error("half way");
      });
    } catch (e) {
      caught = e;
    }
    expect(A.formatError(caught)).toMatchObject({ touched: true });
    A.beginCall();
    expect(A.formatError(new Error("next"))).toMatchObject({ touched: false });
  });

  it("A.touch marks a write that has no undo group (save, open, purge)", () => {
    const A = core();
    A.beginCall();
    A.touch();
    expect(A.formatError(new Error("save failed")).touched).toBe(true);
  });

  it("A.refuse carries a code and says nothing was touched", () => {
    const A = core();
    A.beginCall();
    let caught: unknown;
    try {
      A.refuse("layer_locked", "Layer 2 is locked");
    } catch (e) {
      caught = e;
    }
    expect(A.formatError(caught)).toMatchObject({ message: "Layer 2 is locked", code: "layer_locked", refused: true, touched: false });
  });
});

describe("bridgeErrorFromHost", () => {
  it("a write's untouched error is not_applied, and the host's own kind is kept as code", () => {
    const e = bridgeErrorFromHost({ message: "No such layer", kind: "bad_args", touched: false }, "op1", { mutates: true, label: "Set" });
    expect(e.toJSON()).toMatchObject({ kind: "evalscript_error", code: "bad_args", outcome: "not_applied" });
    expect(e.next_steps?.[0]).toMatch(/Nothing in the project was changed/);
  });

  it("a refusal is not_applied even if the flag says touched", () => {
    expect(bridgeErrorFromHost({ message: "no", code: "x", refused: true, touched: true }, "op", { mutates: true }).outcome).toBe("not_applied");
  });

  it("a touched error, or one from an older panel without the flag, is unknown with undo and checkpoint steps", () => {
    const touched = bridgeErrorFromHost({ message: "boom", touched: true }, "op", { mutates: true, label: "Batch" });
    const old = bridgeErrorFromHost({ message: "boom" }, "op", { mutates: true, label: "Batch" });
    for (const e of [touched, old]) {
      expect(e.outcome).toBe("unknown");
      expect(e.next_steps?.join(" ")).toMatch(/Do not resend.*Ctrl\+Z.*checkpoint/s);
    }
  });

  it("a read has no outcome", () => {
    const e = bridgeErrorFromHost({ message: "boom", kind: "runtime" }, "op");
    expect(e.outcome).toBeUndefined();
    expect(e.code).toBeUndefined();
  });
});

describe("withOutcome", () => {
  it("keeps the host's not_applied for a write failure, and names the checkpoint for unknown", () => {
    const na = new BridgeError({ kind: "evalscript_error", message: "m", outcome: "not_applied" });
    expect(withOutcome(na, "unknown", "L", "/cp.aep")).toBe(na);
    const u = withOutcome(new BridgeError({ kind: "timeout", message: "m" }), "unknown", "L", "/cp.aep");
    expect(u.outcome).toBe("unknown");
    expect(u.next_steps?.join(" ")).toContain("/cp.aep");
  });
});

describe("runGuardedWrite outcomes", () => {
  it("success says applied, a host no-op says no_op", async () => {
    const { ctx } = fakeAe(() => ({ ok: true, result: {} }));
    expect(await runGuardedWrite(ctx, spec)).toMatchObject({ applied: true, outcome: "applied" });
    const noop = fakeAe(() => ({ ok: true, result: { no_op: true } }));
    expect(await runGuardedWrite(noop.ctx, spec)).toMatchObject({ outcome: "no_op" });
  });

  it("a host error before the project was touched is not_applied", async () => {
    const { ctx } = fakeAe((fn) => (fn === "testWrite" ? { ok: false, error: { message: "No layer named X", kind: "bad_args", touched: false } } : { ok: true, result: {} }));
    const err = await runGuardedWrite(ctx, spec).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.toJSON()).toMatchObject({ outcome: "not_applied", code: "bad_args" });
  });

  it("a host error after the undo group opened is unknown", async () => {
    const { ctx } = fakeAe((fn) => (fn === "testWrite" ? { ok: false, error: { message: "boom", touched: true } } : { ok: true, result: {} }));
    const err = await runGuardedWrite(ctx, spec).catch((e) => e);
    expect(err.outcome).toBe("unknown");
    expect(err.next_steps.join(" ")).toMatch(/Ctrl\+Z/);
  });

  it("a guard failure is not_applied: the write was never sent", async () => {
    const { ctx, calls } = fakeAe(() => ({ ok: true, result: {} }));
    const err = await runGuardedWrite(ctx, { ...spec, expect: { project_path: "/other.aep" } }).catch((e) => e);
    expect(err.kind).toBe("guard");
    expect(err.outcome).toBe("not_applied");
    expect(calls).not.toContain("testWrite");
  });

  it("a failing read before the write is not_applied", async () => {
    const { ctx, calls } = fakeAe((fn) => (fn === "testRead" ? { ok: false, error: { message: "read broke" } } : { ok: true, result: {} }));
    const err = await runGuardedWrite(ctx, { ...spec, read: () => ({ host: "testRead", args: {} }) }).catch((e) => e);
    expect(err.outcome).toBe("not_applied");
    expect(calls).not.toContain("testWrite");
  });
});

describe("ae_batch_set: a later chunk's failure keeps the chunks already written", () => {
  const opacity = ["ADBE Transform Group", "ADBE Opacity"];
  const tool = productionTools.find((t) => t.name === "ae_batch_set")!;
  const ops = [1, 2, 3, 4].map((i) => ({ layer: { index: i }, path: opacity, value: i }));

  it("reports outcome partial, the written chunk, and the failing chunk's own outcome", async () => {
    let writes = 0;
    const { ctx } = fakeAe((fn, script) => {
      if (fn === "batchSet") {
        writes++;
        if (writes === 2) return { ok: false, error: { message: "AE error in op 3", touched: true } };
        return { ok: true, result: { done: 2 } };
      }
      const asked = JSON.parse(script.slice(script.indexOf("(") + 1, -1)).ops as Array<{ layer: { index: number } }>;
      return { ok: true, result: { time: 0, results: asked.map((o, i) => ({ op: i + 1, numKeys: 0, value: o.layer.index, expression: "" })) } };
    });
    const out = await tool.handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: { project_path: "<unsaved>" } }), ctx);
    expect(out).toMatchObject({ ok: false, outcome: "partial", done: 2, failed_chunk: "3-4", failed_chunk_outcome: "unknown" });
    expect(out.chunks).toHaveLength(1);
    expect(out.message).toMatch(/Ops 1-2 were applied/);
  });

  it("the first chunk's failure is thrown as it is, with its outcome", async () => {
    const { ctx } = fakeAe((fn) => (fn === "batchSet" ? { ok: false, error: { message: "bad", kind: "bad_args", touched: false } } : { ok: true, result: { time: 0, results: [] } }));
    const err = await tool.handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: { project_path: "<unsaved>" } }), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).outcome).toBe("not_applied");
  });
});

describe("ae_batch_set: review follow-ups", () => {
  const opacity = ["ADBE Transform Group", "ADBE Opacity"];
  const tool = productionTools.find((t) => t.name === "ae_batch_set")!;
  const ops = [1, 2, 3, 4].map((i) => ({ layer: { index: i }, path: opacity, value: i }));
  const readBack = (script: string) => {
    const asked = JSON.parse(script.slice(script.indexOf("(") + 1, -1)).ops as Array<{ layer: { index: number } }>;
    return { ok: true as const, result: { time: 0, results: asked.map((o, i) => ({ op: i + 1, numKeys: 0, value: o.layer.index, expression: "" })) } };
  };

  it("a quarantine between chunks keeps the chunks already written in the answer", async () => {
    let ctxRef: ToolContext | null = null;
    const { ctx } = fakeAe((fn, script) => {
      if (fn === "batchSet") {
        // Another client's write timed out while this batch waited: the next chunk meets the quarantine.
        ctxRef!.quarantine.add({ op_id: "other_op", tool: "ae_set_property", label: "other", reason: "timed out" });
        return { ok: true, result: { done: 2 } };
      }
      return readBack(script);
    });
    ctxRef = ctx;
    const out = await tool.handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: { project_path: "<unsaved>" } }), ctx);
    expect(out).toMatchObject({ ok: false, outcome: "partial", error: "quarantined", done: 2, failed_chunk: "3-4", failed_chunk_outcome: "not_applied" });
    expect(out.chunks).toHaveLength(1);
  });

  it("a first op that fails part-way, with nothing else applied, is unknown, not not_applied", async () => {
    const { ctx } = fakeAe((fn, script) => (fn === "batchSet" ? { ok: true, result: { done: 0, failed_at: 1, error: "boom" } } : readBack(script)));
    const out = await tool.handler(AeBatchSetSchema.parse({ comp_id: 1, ops, chunk_size: 2, expect: { project_path: "<unsaved>" } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "op_failed", outcome: "unknown", done: 0 });
  });
});
