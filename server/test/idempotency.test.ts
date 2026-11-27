/**
 * Idempotency keys on write tools and the recent-writes list (ae_recent_ops), through callTool
 * (the path tools/call and ae_invoke_tool share), counting the writes that reach AE.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS, resetIdempotency, stableStringify, withIdempotency } from "../src/idempotency.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { callTool } from "../src/tool-call.js";
import type { ToolContext } from "../src/tools/common.js";
import { isWriteTool } from "../src/write-tools.js";

const tmpDirs: string[] = [];
beforeEach(() => resetIdempotency());
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const opacity = ["ADBE Transform Group", "ADBE Opacity"];
const batch = (value: number, key?: string) => ({
  comp_id: 1,
  ops: [{ layer: { index: 1 }, path: opacity, value }],
  expect: { project_path: "<unsaved>" },
  ...(key !== undefined ? { idempotency_key: key } : {}),
});

/** A panel that answers ae_batch_set; `writeError` makes batchSet fail with that host error. */
function fakeAe(opts: { writeError?: Record<string, unknown>; slowMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-idem-"));
  tmpDirs.push(dir);
  let writes = 0;
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      if (fn === "batchSet") {
        writes++;
        if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
        if (opts.writeError) return { ok: false, error: opts.writeError as never };
        return { ok: true, result: { done: 1 }, durationMs: 1 };
      }
      const asked = JSON.parse(script.slice(script.indexOf("(") + 1, -1)).ops ?? [];
      return { ok: true, result: { time: 0, results: asked.map((_o: unknown, i: number) => ({ op: i + 1, numKeys: 0, value: 50, expression: "" })) }, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, writes: () => writes };
}

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("which tools take a key", () => {
  it("writes do, reads do not", () => {
    for (const n of ["ae_batch_set", "ae_set_property", "ae_create_layer", "ae_aerender_start", "ae_save", "ae_run_jsx"]) expect(isWriteTool(n)).toBe(true);
    for (const n of ["ae_status", "ae_get_comp", "ae_recent_ops", "ae_search_tools"]) expect(isWriteTool(n)).toBe(false);
  });
});

describe("idempotency_key", () => {
  it("a resend with the same key and arguments runs once and replays the answer", async () => {
    const { ctx, writes } = fakeAe();
    const first = body(await callTool("ae_batch_set", batch(50, "k1"), ctx));
    const again = body(await callTool("ae_batch_set", batch(50, "k1"), ctx));
    expect(writes()).toBe(1);
    expect(first).toMatchObject({ ok: true, outcome: "applied" });
    expect(first.idempotent_replay).toBeUndefined();
    expect(again).toMatchObject({ ok: true, outcome: "applied", idempotent_replay: true });
    expect(typeof again.first_called_at).toBe("string");
  });

  it("the same arguments in another key order still match", () => {
    expect(stableStringify({ a: 1, b: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe(stableStringify({ b: { c: [1, { x: 2, y: 1 }], d: 2 }, a: 1 }));
  });

  it("a second call while the first is still running waits for it instead of writing again", async () => {
    const { ctx, writes } = fakeAe({ slowMs: 50 });
    const [a, b] = await Promise.all([callTool("ae_batch_set", batch(50, "k2"), ctx), callTool("ae_batch_set", batch(50, "k2"), ctx)]);
    expect(writes()).toBe(1);
    expect(body(a).ok).toBe(true);
    expect(body(b)).toMatchObject({ ok: true, idempotent_replay: true, waited_for_first_call: true });
  });

  it("the same key with other arguments is refused, and nothing runs", async () => {
    const { ctx, writes } = fakeAe();
    await callTool("ae_batch_set", batch(50, "k3"), ctx);
    const r = await callTool("ae_batch_set", batch(60, "k3"), ctx);
    expect(r).toMatchObject({ isError: true });
    expect(body(r)).toMatchObject({ code: "idempotency_key_reused", outcome: "not_applied" });
    expect(writes()).toBe(1);
  });

  it("the same key in another project is a new write, not a reuse (two sessions naming keys alike)", async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, applied: true }) }] };
    };
    const a = await withIdempotency("ae_layer_ops", "trim-clip-2-5", { action: "trim", expect: { project_path: "C:/a/one.aep" } }, run);
    const b = await withIdempotency("ae_layer_ops", "trim-clip-2-5", { action: "trim", expect: { project_path: "C:/b/two.aep" } }, run);
    expect(runs).toBe(2);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    // In the same project, other arguments under the same key are still refused.
    const c = await withIdempotency("ae_layer_ops", "trim-clip-2-5", { action: "trim", in_point: 3, expect: { project_path: "C:/b/two.aep" } }, run);
    expect(JSON.parse(c.response.content[0].text)).toMatchObject({ code: "idempotency_key_reused" });
    expect(runs).toBe(2);
  });

  it("without a key every call runs", async () => {
    const { ctx, writes } = fakeAe();
    await callTool("ae_batch_set", batch(50), ctx);
    await callTool("ae_batch_set", batch(50), ctx);
    expect(writes()).toBe(2);
  });

  it("a not_applied failure is not kept: the resend runs again", async () => {
    const { ctx, writes } = fakeAe({ writeError: { message: "No layer 1", kind: "bad_args", touched: false } });
    const a = await callTool("ae_batch_set", batch(50, "k4"), ctx);
    expect(body(a).outcome).toBe("not_applied");
    await callTool("ae_batch_set", batch(50, "k4"), ctx);
    expect(writes()).toBe(2);
  });

  it("an unknown failure is kept: the resend gets the same answer and does not write again", async () => {
    const { ctx, writes } = fakeAe({ writeError: { message: "AE error", touched: true } });
    await callTool("ae_batch_set", batch(50, "k5"), ctx);
    const again = await callTool("ae_batch_set", batch(50, "k5"), ctx);
    expect(writes()).toBe(1);
    expect(again).toMatchObject({ isError: true });
    expect(body(again)).toMatchObject({ outcome: "unknown", idempotent_replay: true });
  });

  it("a key that is not a short string is refused as an invalid argument", async () => {
    const { ctx, writes } = fakeAe();
    for (const bad of ["", "x".repeat(129), 42]) {
      const r = await callTool("ae_batch_set", { ...batch(50), idempotency_key: bad }, ctx);
      expect(body(r).message).toMatch(/Invalid arguments for ae_batch_set: idempotency_key/);
    }
    expect(writes()).toBe(0);
  });

  it("keys expire after an hour and the oldest go past 200", async () => {
    let t = 1_000_000;
    const now = () => t;
    let runs = 0;
    const run = async () => {
      runs++;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, outcome: "applied" }) }] };
    };
    await withIdempotency("ae_x", "old", {}, run, now);
    t += IDEMPOTENCY_TTL_MS + 1;
    await withIdempotency("ae_x", "old", {}, run, now);
    expect(runs).toBe(2);
    for (let i = 0; i < IDEMPOTENCY_MAX_ENTRIES + 5; i++) await withIdempotency("ae_x", `k${i}`, {}, run, now);
    runs = 0;
    await withIdempotency("ae_x", "k0", {}, run, now);
    expect(runs).toBe(1);
    await withIdempotency("ae_x", `k${IDEMPOTENCY_MAX_ENTRIES + 4}`, {}, run, now);
    expect(runs).toBe(1);
  });
});

describe("ae_recent_ops", () => {
  it("lists writes newest first with outcome, op_id, key and replay; reads are not listed", async () => {
    const { ctx } = fakeAe();
    await callTool("ae_batch_set", batch(50, "r1"), ctx);
    await callTool("ae_batch_set", batch(50, "r1"), ctx);
    await callTool("ae_recent_ops", {}, ctx);
    const r = body(await callTool("ae_recent_ops", { limit: 5 }, ctx));
    expect(r.count).toBe(2);
    expect(r.ops[0]).toMatchObject({ tool: "ae_batch_set", outcome: "applied", ok: true, idempotency_key: "r1", idempotent_replay: true });
    expect(r.ops[1]).toMatchObject({ tool: "ae_batch_set", outcome: "applied", idempotency_key: "r1" });
    expect(r.ops[1].idempotent_replay).toBeUndefined();
    expect(typeof r.ops[1].ms).toBe("number");
  });

  it("records a failed write's outcome and error", async () => {
    const { ctx } = fakeAe({ writeError: { message: "No layer 1", kind: "bad_args", touched: false } });
    await callTool("ae_batch_set", batch(50), ctx);
    const r = body(await callTool("ae_recent_ops", { tool: "ae_batch_set" }, ctx));
    expect(r.ops[0]).toMatchObject({ outcome: "not_applied", ok: false, code: "bad_args" });
    expect(r.ops[0].error).toMatch(/No layer 1/);
  });

  it("a call refused for its arguments is listed as not_applied", async () => {
    const { ctx } = fakeAe();
    await callTool("ae_batch_set", { comp_id: 1, expect: { project_path: "<unsaved>" } }, ctx);
    const r = body(await callTool("ae_recent_ops", {}, ctx));
    expect(r.ops[0]).toMatchObject({ tool: "ae_batch_set", outcome: "not_applied", ok: false });
  });
});

describe("a successful write always carries an outcome", () => {
  it("adds outcome applied to a write result that has applied: true and no outcome of its own", async () => {
    const { ctx } = fakeAe();
    const fake = {
      name: "ae_fake_write",
      description: "test",
      schema: (await import("zod")).z.object({ expect: (await import("zod")).z.object({ project_path: (await import("zod")).z.string() }) }),
      handler: async () => ({ applied: true, receipt: { matches: true } }),
    };
    const { ALL_TOOLS } = await import("../src/tools/registry.js");
    ALL_TOOLS.push(fake);
    try {
      const r = body(await callTool("ae_fake_write", { expect: { project_path: "<unsaved>" } }, ctx));
      expect(r).toMatchObject({ applied: true, outcome: "applied" });
    } finally {
      ALL_TOOLS.splice(ALL_TOOLS.indexOf(fake), 1);
    }
  });
});

describe("idempotency: refusals that changed nothing, and the client scope", () => {
  const ok = { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, outcome: "applied" }) }] };
  for (const kind of ["quarantined", "queued", "guard"]) {
    it(`a ${kind} refusal is not kept: the resend runs`, async () => {
      let runs = 0;
      const refusal = { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ kind, message: "refused" }) }] };
      await withIdempotency("ae_x", `k-${kind}`, {}, async () => (runs++, refusal));
      const second = await withIdempotency("ae_x", `k-${kind}`, {}, async () => (runs++, ok));
      expect(runs).toBe(2);
      expect(second.replayed).toBe(false);
    });
  }

  it("the same key from two clients runs twice; from one client once", async () => {
    let runs = 0;
    const run = async () => (runs++, ok);
    await withIdempotency("ae_x", "shared", {}, run, Date.now, "claude-code");
    await withIdempotency("ae_x", "shared", {}, run, Date.now, "claude-ai");
    expect(runs).toBe(2);
    const again = await withIdempotency("ae_x", "shared", {}, run, Date.now, "claude-code");
    expect(runs).toBe(2);
    expect(again.replayed).toBe(true);
  });
});
