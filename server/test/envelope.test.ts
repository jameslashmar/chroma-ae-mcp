import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BridgeError } from "../src/host.js";
import { listTools } from "../src/mcp-rpc.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { callTool } from "../src/tool-call.js";
import type { ToolContext, ToolDefinition } from "../src/tools/common.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.CHROMA_AE_MCP_STRUCTURED;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function ctx(): ToolContext {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-env-"));
  dirs.push(d);
  return { bridge: {} as never, queue: new SingleWriterQueue(), quarantine: new QuarantineStore(path.join(d, "q.json")) };
}
/** Runs `fn` with fake tools in the registry (a write is a tool whose schema takes expect). */
async function withTools<T>(tools: ToolDefinition<any>[], fn: () => Promise<T>): Promise<T> {
  ALL_TOOLS.push(...tools);
  try {
    return await fn();
  } finally {
    for (const t of tools) ALL_TOOLS.splice(ALL_TOOLS.indexOf(t), 1);
  }
}
// Each fake gets its own name: findTool and isWriteTool cache by registry length, so a second fake under the same name would be missed.
let seq = 0;
let lastRead = "";
let lastWrite = "";
const read = (handler: () => Promise<unknown>): ToolDefinition<any> => ({ name: (lastRead = `ae_zz_read_${++seq}`), description: "t", schema: z.object({ n: z.number().optional() }), handler });
const write = (handler: () => Promise<unknown>): ToolDefinition<any> => ({ name: (lastWrite = `ae_zz_write_${++seq}`), description: "t", schema: z.object({ expect: z.object({ project_path: z.string() }) }), handler });
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const E = { expect: { project_path: "<unsaved>" } };

describe("result envelope", () => {
  it("success: ok true first, the tool's fields untouched", async () => {
    const r = await withTools([read(async () => ({ id: 3, name: "A" }))], () => callTool(lastRead, {}, ctx()));
    expect(r.content[0].text).toBe(JSON.stringify({ ok: true, id: 3, name: "A" }));
  });

  it("a typed refusal keeps ok false and gets its error as code", async () => {
    const r = await withTools([read(async () => ({ ok: false, error: "empty_queue", message: "m" }))], () => callTool(lastRead, {}, ctx()));
    expect(body(r)).toMatchObject({ ok: false, code: "empty_queue", error: "empty_queue" });
  });

  it("invalid arguments: ok false, code invalid_args, and not_applied for a write", async () => {
    const c = ctx();
    const [rd, wr] = await withTools([read(async () => ({})), write(async () => ({ applied: true }))], async () => [
      await callTool(lastRead, { n: "x" }, c),
      await callTool(lastWrite, {}, c),
    ]);
    expect(body(rd)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(body(rd).outcome).toBeUndefined();
    expect(body(wr)).toMatchObject({ ok: false, code: "invalid_args", outcome: "not_applied" });
  });

  it("a guard refusal of a write is not_applied, a timeout unknown; the host's own code wins", async () => {
    const c = ctx();
    const throwing = (err: BridgeError) => write(async () => { throw err; });
    const g = await withTools([throwing(new BridgeError({ kind: "guard", message: "other project" }))], () => callTool(lastWrite, E, c));
    expect(body(g)).toMatchObject({ ok: false, code: "guard", outcome: "not_applied" });
    const t = await withTools([throwing(new BridgeError({ kind: "timeout", message: "slow" }))], () => callTool(lastWrite, E, c));
    expect(body(t)).toMatchObject({ ok: false, code: "timeout", outcome: "unknown" });
    const h = await withTools([throwing(new BridgeError({ kind: "evalscript_error", message: "x", code: "not_found", outcome: "not_applied" }))], () => callTool(lastWrite, E, c));
    expect(body(h)).toMatchObject({ ok: false, code: "not_found", outcome: "not_applied" });
  });

  it("structuredContent only with CHROMA_AE_MCP_STRUCTURED=1, and outputSchema only then, only in the full list", async () => {
    const off = await withTools([read(async () => ({ id: 1 }))], () => callTool(lastRead, {}, ctx()));
    expect((off as { structuredContent?: unknown }).structuredContent).toBeUndefined();
    expect(listTools("full")[0].outputSchema).toBeUndefined();
    process.env.CHROMA_AE_MCP_STRUCTURED = "1";
    const on = await withTools([read(async () => ({ id: 1 }))], () => callTool(lastRead, {}, ctx()));
    expect((on as { structuredContent?: unknown }).structuredContent).toEqual({ ok: true, id: 1 });
    const arr = await withTools([read(async () => [1, 2])], () => callTool(lastRead, {}, ctx()));
    expect((arr as { structuredContent?: unknown }).structuredContent).toEqual({ ok: true, result: [1, 2] });
    expect(listTools("full")[0].outputSchema).toMatchObject({ type: "object", required: ["ok"] });
    expect(listTools("core").every((e) => e.outputSchema === undefined)).toBe(true);
  });
});
