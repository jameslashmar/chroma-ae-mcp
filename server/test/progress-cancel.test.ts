/**
 * Progress notifications and cancellation (call-context.ts): one progress event per After Effects
 * eval of a tools/call that asked for them, and a cancelled call stopping at its next safe point,
 * never by abandoning an eval already sent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cancelCall, CancelledError, checkCancelled, noteProgress, runInCall } from "../src/call-context.js";
import { handleRpc } from "../src/mcp-rpc.js";
import { createPanelMcp } from "../src/panel-entry.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext, ToolDefinition } from "../src/tools/common.js";
import { runGuardedWrite } from "../src/tools/ext/write-runner.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-pc-"));
  dirs.push(d);
  return d;
};

/** A panel whose evals answer after `delayMs`; records each eval's function name. */
function fakeAe(delayMs = 0) {
  const sent: string[] = [];
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(tmp(), "q.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      sent.push(fn);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      return { ok: true, result: {}, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine };
  return { ctx, sent };
}

let seq = 0;
/** A fake tool that runs `steps` reads, one queue turn each. */
function stepsTool(steps: number): ToolDefinition<any> {
  return {
    name: `ae_zz_steps_${++seq}`,
    description: "t",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      for (let i = 0; i < steps; i++) {
        // evalRaw inside the tool's own queue turn (callHost takes a turn itself, so it cannot nest here).
        await ctx.queue.run(`step ${i}`, () => ctx.bridge.evalRaw({ id: `s${i}`, script: `__chromaAe.probe({"i":${i}})`, label: `step ${i + 1} of ${steps}`, mutates: false }));
      }
      return { done: steps };
    },
  };
}

describe("call context", () => {
  it("cancellation is scoped to the client and the request id", async () => {
    const state = { requestId: 7, client: "a", cancelled: false, progress: 0 };
    await runInCall(state, async () => {
      expect(cancelCall("b", 7)).toBe(false);
      expect(cancelCall("a", "7")).toBe(false);
      expect(() => checkCancelled("x")).not.toThrow();
      expect(cancelCall("a", 7, "user stopped it")).toBe(true);
      expect(() => checkCancelled("the next frame")).toThrow(CancelledError);
    });
    expect(cancelCall("a", 7)).toBe(false); // finished calls are forgotten
  });

  it("progress counts up and goes only where it was asked for", async () => {
    const got: any[] = [];
    noteProgress("outside any call"); // no call: nothing, no throw
    await runInCall({ requestId: 1, client: "", cancelled: false, progress: 0, progressToken: "tok", notify: (m) => got.push(m) }, async () => {
      noteProgress("a");
      noteProgress("b");
    });
    await runInCall({ requestId: 2, client: "", cancelled: false, progress: 0, notify: (m) => got.push(m) }, async () => noteProgress("no token"));
    expect(got.map((m) => [m.method, m.params.progressToken, m.params.progress, m.params.message])).toEqual([
      ["notifications/progress", "tok", 1, "a"],
      ["notifications/progress", "tok", 2, "b"],
    ]);
  });
});

describe("through tools/call", () => {
  it("one progress notification per eval, with the eval's label", async () => {
    const tool = stepsTool(3);
    ALL_TOOLS.push(tool);
    try {
      const { ctx } = fakeAe();
      const notes: any[] = [];
      const res: any = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: tool.name, arguments: {}, _meta: { progressToken: 99 } } }, ctx, { notify: (m) => notes.push(m) });
      expect(JSON.parse(res.result.content[0].text)).toMatchObject({ ok: true, done: 3 });
      expect(notes.map((n) => n.params.message)).toEqual(["step 1 of 3", "step 2 of 3", "step 3 of 3"]);
      expect(notes.every((n) => n.params.progressToken === 99)).toBe(true);
    } finally {
      ALL_TOOLS.splice(ALL_TOOLS.indexOf(tool), 1);
    }
  });

  it("notifications/cancelled stops the call at its next queue turn; the eval in flight finishes", async () => {
    const tool = stepsTool(5);
    ALL_TOOLS.push(tool);
    try {
      const { ctx, sent } = fakeAe(30);
      const call = handleRpc({ jsonrpc: "2.0", id: "c1", method: "tools/call", params: { name: tool.name, arguments: {} } }, ctx, { client: "claude-code" });
      await new Promise((r) => setTimeout(r, 45)); // the second eval is in flight
      expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "c1", reason: "user" } }, ctx, { client: "claude-code" })).toBeNull();
      const res: any = await call;
      const body = JSON.parse(res.result.content[0].text);
      expect(res.result.isError).toBe(true);
      expect(body).toMatchObject({ ok: false, code: "cancelled" });
      expect(body.message).toMatch(/user/);
      expect(sent.length).toBe(2); // the one in flight ended; no third was sent
    } finally {
      ALL_TOOLS.splice(ALL_TOOLS.indexOf(tool), 1);
    }
  });

  it("a guarded write cancelled before it is sent is not_applied, and the write never reaches AE", async () => {
    const { ctx, sent } = fakeAe();
    const state = { requestId: 1, client: "", cancelled: false, progress: 0 };
    const err = await runInCall(state, async () =>
      runGuardedWrite(ctx, {
        toolName: "ae_t",
        label: "t",
        expect: { project_path: "<unsaved>" },
        read: () => {
          state.cancelled = true; // cancelled while the before-read runs
          return { host: "testRead", args: {} };
        },
        write: { host: "testWrite", args: {} },
      })
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect(err.outcome).toBe("not_applied");
    expect(sent).not.toContain("testWrite");
  });
});

describe("the panel's /mcp as an event stream", () => {
  it("streams progress, then the result, when the request takes text/event-stream and has a progress token", async () => {
    const tool = stepsTool(2);
    ALL_TOOLS.push(tool);
    try {
      const mcp = createPanelMcp({
        evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }),
        dataDir: tmp(),
        sessionTracking: false,
      } as any);
      const writes: string[] = [];
      const headers: Record<string, string> = {};
      const res = { statusCode: 0, writableEnded: false, setHeader: (k: string, v: string) => (headers[k] = v), write: (c: string) => writes.push(c), end: (b?: string) => { if (b) writes.push(b); res.writableEnded = true; } };
      const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: {}, _meta: { progressToken: "p" } } });
      await mcp.handleHttp({ method: "POST", headers: { accept: "application/json, text/event-stream" } } as any, res as any, body);
      expect(headers["Content-Type"]).toBe("text/event-stream");
      const events = writes.join("").split("\n\n").filter(Boolean).map((e) => JSON.parse(e.replace(/^event: message\ndata: /, "")));
      expect(events.map((e) => e.method ?? `result ${e.id}`)).toEqual(["notifications/progress", "notifications/progress", "result 3"]);
      mcp.stop();

      // Without the Accept header the same call is one JSON reply.
      const mcp2 = createPanelMcp({ evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }), dataDir: tmp(), sessionTracking: false } as any);
      const out: string[] = [];
      const h2: Record<string, string> = {};
      const res2 = { statusCode: 0, writableEnded: false, setHeader: (k: string, v: string) => (h2[k] = v), write: (c: string) => out.push(c), end: (b?: string) => { if (b) out.push(b); res2.writableEnded = true; } };
      await mcp2.handleHttp({ method: "POST", headers: { accept: "application/json" } } as any, res2 as any, body);
      expect(h2["Content-Type"]).toBe("application/json");
      expect(JSON.parse(out.join("")).id).toBe(3);
      mcp2.stop();
    } finally {
      ALL_TOOLS.splice(ALL_TOOLS.indexOf(tool), 1);
    }
  });
});
