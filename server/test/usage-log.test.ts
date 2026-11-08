import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callMetaTool } from "../src/meta-tools.js";
import { handleRpc } from "../src/mcp-rpc.js";
import { createPanelMcp } from "../src/panel-entry.js";
import { callTool } from "../src/tool-call.js";
import { BridgeError } from "../src/host.js";
import type { ToolContext, ToolDefinition } from "../src/tools/common.js";
import { ALL_TOOLS } from "../src/tools/registry.js";
import { QueueWaitError } from "../src/queue.js";
import { QuarantineBlockedError } from "../src/quarantine.js";
import { PlanarError } from "../src/tools/ext/planar.js";
import { droppedUsageLines, flushUsageLog, MAX_QUEUED, recordUsage, resetUsageLogForTests, sanitizeError } from "../src/usage-log.js";

const FAKE_OK = "zz_usage_ok";
const FAKE_BAD = "zz_usage_bad";
const FAKE_BRIDGE = "zz_usage_bridge";
const FAKE_WAIT = "zz_usage_wait";

const fakes: ToolDefinition<any>[] = [
  { name: FAKE_OK, description: "fake", schema: z.object({ secret: z.string().optional() }).strict(), handler: async () => ({ done: true, secret_result: "do-not-log" }) },
  { name: FAKE_BAD, description: "fake", schema: z.object({}).strict(), handler: async () => { throw new Error("plain\nfailure " + "x".repeat(400)); } },
  { name: FAKE_BRIDGE, description: "fake", schema: z.object({}).strict(), handler: async () => { throw new BridgeError({ kind: "queued", message: "AE is busy" }); } },
  { name: FAKE_WAIT, description: "fake", schema: z.object({ w: z.any().optional() }).strict(), handler: async (a: any) => ({ done: true, waited_ms: a.w }) },
];

describe("usage log", () => {
  let dir: string;
  let ctx: ToolContext;

  async function lines(): Promise<Record<string, any>[]> {
    await flushUsageLog();
    const usage = path.join(dir, "usage");
    if (!fs.existsSync(usage)) return [];
    const out: Record<string, any>[] = [];
    for (const f of fs.readdirSync(usage).sort()) {
      for (const l of fs.readFileSync(path.join(usage, f), "utf8").split("\n")) if (l.trim()) out.push(JSON.parse(l));
    }
    return out;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-usage-"));
    ctx = { dataDir: dir, bridge: { callHost: async () => ({ id: "op1", result: 1 }) } } as unknown as ToolContext;
    process.env.CHROMA_AE_MCP_USAGE_LOG = "on";
    resetUsageLogForTests();
    for (const f of fakes) if (!ALL_TOOLS.includes(f)) ALL_TOOLS.push(f);
  });

  afterEach(async () => {
    await flushUsageLog();
    process.env.CHROMA_AE_MCP_USAGE_LOG = "off";
    for (const f of fakes) {
      const i = ALL_TOOLS.indexOf(f);
      if (i >= 0) ALL_TOOLS.splice(i, 1);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records waited_ms from a numeric waited_ms in the output, and ignores anything else", async () => {
    await callTool(FAKE_WAIT, { w: 1500 }, ctx);
    await callTool(FAKE_WAIT, { w: "soon" }, ctx);
    await callTool(FAKE_WAIT, { w: 0 }, ctx);
    await callTool(FAKE_OK, {}, ctx);
    const l = await lines();
    expect(l[0].waited_ms).toBe(1500);
    expect(l[1].waited_ms).toBeUndefined();
    expect(l[2].waited_ms).toBeUndefined();
    expect(l[3].waited_ms).toBeUndefined();
  });

  it("records the client name, clipped to 40 characters, and leaves the field out when unknown", async () => {
    await callTool(FAKE_OK, {}, ctx, { toolset: "core", client: "claude-ai" });
    await callTool(FAKE_OK, {}, ctx, {});
    await callTool(FAKE_OK, {}, ctx, { client: "c".repeat(100) });
    await callMetaTool("ae_invoke_tool", { name: FAKE_OK, arguments: {} }, ctx, { toolset: "core", client: "cursor" });
    await callMetaTool("ae_search_tools", { query: "zzzz qqqq nonsense" }, ctx, { toolset: "core", client: "claude-ai" });
    const all = await lines();
    expect(all[0]).toMatchObject({ client: "claude-ai", toolset: "core" });
    expect(all[1]).not.toHaveProperty("client");
    expect(all[2].client).toBe("c".repeat(40));
    expect(all[3]).toMatchObject({ tool: FAKE_OK, via: "ae_invoke_tool", client: "cursor" });
    expect(all[4]).toMatchObject({ tool: "ae_search_tools", client: "claude-ai" });
  });

  it("carries the client from handleRpc options and from the X-Chroma-Client header to the log", async () => {
    await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: FAKE_OK, arguments: {} } }, ctx, { toolset: "core", client: "claude-ai" });
    await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: FAKE_OK, arguments: {} } }, ctx, { client: "  " });
    const mcp = createPanelMcp({ evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }), dataDir: dir, watchAssets: false, sessionTracking: false } as any);
    try {
      const send = async (headers: Record<string, string>) => {
        const res: any = { statusCode: 0, writableEnded: false, setHeader() {}, end() { this.writableEnded = true; } };
        const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: FAKE_OK, arguments: {} } });
        await mcp.handleHttp({ method: "POST", url: "/mcp", headers }, res, body);
      };
      await send({ "x-chroma-client": "cursor" });
      await send({ "x-chroma-client": "x".repeat(90) });
      await send({});
    } finally {
      mcp.stop();
    }
    const all = await lines();
    expect(all.map((l) => l.client)).toEqual(["claude-ai", undefined, "cursor", "x".repeat(40), undefined]);
  });

  it("writes the documented fields for a good call and never the arguments or results", async () => {
    await callTool(FAKE_OK, { secret: "do-not-log" }, ctx, { toolset: "core" });
    const [line] = await lines();
    expect(Object.keys(line).sort()).toEqual(["day", "ms", "ok", "result_chars", "tool", "toolset", "ts", "via"].sort());
    expect(line).toMatchObject({ tool: FAKE_OK, ok: true, toolset: "core", via: "direct" });
    expect(line.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(line.ts).toString()).not.toBe("Invalid Date");
    expect(JSON.stringify(line)).not.toContain("do-not-log");
    const file = fs.readdirSync(path.join(dir, "usage"))[0];
    expect(file).toMatch(/^usage-\d{4}-\d{2}\.jsonl$/);
  });

  it("records failure kinds: bridge kind, error, invalid_args, unknown_tool", async () => {
    await callTool(FAKE_BAD, {}, ctx);
    await callTool(FAKE_BRIDGE, {}, ctx);
    await callTool(FAKE_BAD, { nope: 1 }, ctx);
    await callTool("zz_not_a_tool", {}, ctx);
    const [a, b, c, d] = await lines();
    expect(a).toMatchObject({ ok: false, error_kind: "error" });
    expect(a.error).not.toMatch(/\n/);
    expect(a.error.length).toBeLessThanOrEqual(160);
    expect(b).toMatchObject({ ok: false, error_kind: "queued", error: "AE is busy" });
    expect(c).toMatchObject({ ok: false, error_kind: "invalid_args" });
    expect(d).toMatchObject({ ok: false, error_kind: "unknown_tool", tool: "zz_not_a_tool" });
  });

  it("takes the error kind from kind, then code, else error", async () => {
    const thrown: Error[] = [
      new QueueWaitError("op", 5000, "other"),
      new QuarantineBlockedError([{ op_id: "op1" } as any]),
      new PlanarError("not_found", "no such track"),
      new Error("plain"),
    ];
    for (let i = 0; i < thrown.length; i++) {
      const t: ToolDefinition<any> = { name: "zz_usage_kind" + i, description: "fake", schema: z.object({}).strict(), handler: async () => { throw thrown[i]; } };
      ALL_TOOLS.push(t);
      fakes.push(t);
      await callTool(t.name, {}, ctx);
    }
    expect((await lines()).map((l) => l.error_kind)).toEqual(["queued", "quarantined", "not_found", "error"]);
    fakes.length = 3;
  });

  it("records ae_run_jsx label, mutates and code size, with a bounded label", async () => {
    await callTool("ae_run_jsx", { code: "return 1;", mutates: false, label: "x".repeat(300) }, ctx);
    await callTool("ae_run_jsx", { mutates: false, label: "missing code" }, ctx);
    const [ok, bad] = await lines();
    expect(ok).toMatchObject({ tool: "ae_run_jsx", ok: true, mutates: false, code_chars: 9 });
    expect(ok.label).toHaveLength(120);
    expect(bad).toMatchObject({ ok: false, error_kind: "invalid_args", label: "missing code", mutates: false });
    expect(bad).not.toHaveProperty("code_chars");
    expect(JSON.stringify(ok)).not.toContain("return 1");
  });

  it("records ae_search_tools query and hits, bounded, and ae_get_tool_schema without arguments", async () => {
    await callMetaTool("ae_search_tools", { query: "zzzz qqqq nonsense" }, ctx, { toolset: "core" });
    await callMetaTool("ae_search_tools", { query: "layer ".repeat(50) }, ctx);
    await callMetaTool("ae_get_tool_schema", { name: "ae_get_comp" }, ctx);
    const [none, long, schema] = await lines();
    expect(none).toMatchObject({ tool: "ae_search_tools", ok: true, query: "zzzz qqqq nonsense", toolset: "core", via: "direct" });
    expect(none.hits).toBe(0);
    expect(long.query.length).toBeLessThanOrEqual(80);
    expect(long.hits).toBeGreaterThan(0);
    expect(schema).toMatchObject({ tool: "ae_get_tool_schema", ok: true });
    expect(schema).not.toHaveProperty("query");
  });

  it("records result_chars as the length of the text returned, for good calls, errors, invalid args and meta-tools", async () => {
    const good: any = await callTool(FAKE_OK, {}, ctx);
    await callTool(FAKE_OK, { secret: 5 }, ctx);
    const bad: any = await callTool(FAKE_BAD, {}, ctx);
    const unknown: any = await callTool("zz_nothing_like_it", {}, ctx);
    const search: any = await callMetaTool("ae_search_tools", {}, ctx);
    const all = await lines();
    expect(all).toHaveLength(5);
    expect(all[0].result_chars).toBe(good.content[0].text.length);
    expect(all[0].result_chars).toBe(JSON.stringify({ done: true, secret_result: "do-not-log" }).length);
    expect(all[1].result_chars).toBeGreaterThan(0);
    expect(all[2].result_chars).toBe(bad.content[0].text.length);
    expect(all[3].result_chars).toBe(unknown.content[0].text.length);
    expect(all[4].result_chars).toBe(search.content[0].text.length);
    for (const l of all) expect(JSON.stringify(l)).not.toContain("secret_result");
  });

  it("logs ae_invoke_tool as one line for the real tool, via ae_invoke_tool", async () => {
    await callMetaTool("ae_invoke_tool", { name: FAKE_OK, arguments: {} }, ctx, { toolset: "core" });
    const all = await lines();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ tool: FAKE_OK, ok: true, via: "ae_invoke_tool", toolset: "core" });
  });

  it("logs an ae_invoke_tool of an unknown name once, as unknown_tool", async () => {
    await callMetaTool("ae_invoke_tool", { name: "zz_nothing_like_it", arguments: {} }, ctx);
    const all = await lines();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ tool: "zz_nothing_like_it", ok: false, error_kind: "unknown_tool", via: "ae_invoke_tool" });
  });

  it("writes nothing when CHROMA_AE_MCP_USAGE_LOG=off", async () => {
    process.env.CHROMA_AE_MCP_USAGE_LOG = "off";
    await callTool(FAKE_OK, {}, ctx);
    await flushUsageLog();
    expect(fs.existsSync(path.join(dir, "usage"))).toBe(false);
  });

  it("does not throw or fail the call when the directory cannot be written", async () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "a file where the data dir should be");
    const bad = { ...ctx, dataDir: path.join(blocker, "inner") } as ToolContext;
    const res = await callTool(FAKE_OK, {}, bad);
    await flushUsageLog();
    expect("isError" in res && res.isError).toBeFalsy();
    expect(() => recordUsage(bad, { tool: "x", ms: 1, ok: true })).not.toThrow();
  });

  it("deletes usage files older than the current month plus the 3 before it, once per process, keeps newer ones and other files", async () => {
    const usage = path.join(dir, "usage");
    fs.mkdirSync(usage, { recursive: true });
    const now = new Date(2026, 10, 7);
    for (const f of ["usage-2026-06.jsonl", "usage-2026-07.jsonl", "usage-2026-08.jsonl", "usage-2026-10.jsonl", "notes.txt"]) {
      fs.writeFileSync(path.join(usage, f), "{}\n");
    }
    recordUsage(ctx, { tool: "x", ms: 1, ok: true }, now);
    await flushUsageLog();
    const left = fs.readdirSync(usage).sort();
    expect(left).toEqual(["notes.txt", "usage-2026-08.jsonl", "usage-2026-10.jsonl", "usage-2026-11.jsonl"]);
    // Once per process: a file that appears later is not pruned by the next call.
    fs.writeFileSync(path.join(usage, "usage-2024-01.jsonl"), "{}\n");
    recordUsage(ctx, { tool: "x", ms: 1, ok: true }, now);
    await flushUsageLog();
    expect(fs.existsSync(path.join(usage, "usage-2024-01.jsonl"))).toBe(true);
  });

  it("bounds every string field", async () => {
    recordUsage(ctx, {
      tool: "t".repeat(500),
      ms: 1,
      ok: false,
      errorKind: "k".repeat(500),
      error: "e".repeat(500),
      label: "l".repeat(500),
      query: "q".repeat(500),
    });
    const [line] = await lines();
    expect(line.tool.length).toBeLessThanOrEqual(80);
    expect(line.error_kind.length).toBeLessThanOrEqual(40);
    expect(line.error.length).toBeLessThanOrEqual(160);
    expect(line.label.length).toBeLessThanOrEqual(120);
    expect(line.query.length).toBeLessThanOrEqual(80);
  });

  it("sanitises quoted strings, paths and long digit runs out of the error text", () => {
    expect(sanitizeError('Layer "Client Logo v2" not found in ' + "'My Comp'")).toBe('Layer "…" not found in "…"');
    expect(sanitizeError("Cannot open C:\\Users\\Jay Doe\\Projects\\shot 01.aep now")).toBe("Cannot open <path> now");
    expect(sanitizeError("ENOENT /Users/jay/Movies/shot.mov missing")).toBe("ENOENT <path> missing");
    expect(sanitizeError("share \\\\nas\\media\\a.mov failed")).toBe("share <path> failed");
    expect(sanitizeError("id 1234567 frame 12")).toBe("id # frame 12");
    expect(sanitizeError("received “Secret Name” and ‘Other’")).toBe('received "…" and "…"');
    expect(sanitizeError("can't find the layer, don't retry")).toBe("can't find the layer, don't retry");
    expect(sanitizeError("Expected number, received string")).toBe("Expected number, received string");
    expect(sanitizeError("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });

  it("keeps argument values out of the logged error, for thrown errors, validation errors and unknown tools", async () => {
    const leaky: ToolDefinition<any> = {
      name: "zz_usage_leaky",
      description: "fake",
      schema: z.object({ mode: z.enum(["a", "b"]) }).strict(),
      handler: async () => { throw new Error('Layer "Acme Secret Logo" missing in C:\\Clients\\Acme\\final.aep, frame 99999'); },
    };
    ALL_TOOLS.push(leaky);
    fakes.push(leaky);
    await callTool("zz_usage_leaky", { mode: "a" }, ctx);
    await callTool("zz_usage_leaky", { mode: "Acme Secret" }, ctx);
    await callTool("zz_acme_secret_tool", {}, ctx);
    fakes.length = 3;
    const all = await lines();
    expect(all[0]).toMatchObject({ ok: false, error_kind: "error", error: 'Layer "…" missing in <path>, frame #' });
    expect(all[1].error_kind).toBe("invalid_args");
    expect(all[2]).toMatchObject({ error_kind: "unknown_tool", error: "Unknown tool" });
    for (const l of all) {
      expect(JSON.stringify(l.error)).not.toMatch(/Acme|Secret|Clients/);
    }
  });

  it("keeps the ae_run_jsx label and the search query as typed", async () => {
    await callTool("ae_run_jsx", { code: "return 1;", mutates: false, label: "Fix the Acme logo" }, ctx);
    await callMetaTool("ae_search_tools", { query: "Acme logo wobble" }, ctx);
    const [jsx, search] = await lines();
    expect(jsx.label).toBe("Fix the Acme logo");
    expect(search.query).toBe("Acme logo wobble");
  });

  it("records a result with ok: false as result_ok false, with ok still true and a sanitised error", async () => {
    const mk = (name: string, out: unknown): ToolDefinition<any> => ({ name, description: "fake", schema: z.object({}).strict(), handler: async () => out });
    const defs = [
      mk("zz_usage_r1", { ok: false, code: "refused", error: 'Layer "Secret" is locked' }),
      mk("zz_usage_r2", { ok: false, refused: [{ code: "stale_guard", reason: "x" }] }),
      mk("zz_usage_r3", { ok: false, kind: "no_comp", error: { message: "No comp at C:\\a\\b.aep" } }),
      mk("zz_usage_r4", { ok: false }),
      mk("zz_usage_r5", { ok: true, error: "not a failure" }),
      mk("zz_usage_r6", [1, 2]),
    ];
    for (const d of defs) { ALL_TOOLS.push(d); fakes.push(d); }
    for (const d of defs) await callTool(d.name, {}, ctx);
    fakes.length = 3;
    const all = await lines();
    expect(all[0]).toMatchObject({ ok: true, result_ok: false, result_kind: "refused", result_error: 'Layer "…" is locked' });
    expect(all[0]).not.toHaveProperty("error");
    expect(all[1]).toMatchObject({ ok: true, result_ok: false, result_kind: "stale_guard" });
    expect(all[1]).not.toHaveProperty("result_error");
    expect(all[2]).toMatchObject({ result_ok: false, result_kind: "no_comp", result_error: "No comp at <path>" });
    expect(all[3]).toMatchObject({ ok: true, result_ok: false });
    expect(all[3]).not.toHaveProperty("result_kind");
    expect(all[4]).not.toHaveProperty("result_ok");
    expect(all[5]).not.toHaveProperty("result_ok");
  });

  it("records the top hit and its score for a query search, and the group on its own", async () => {
    await callMetaTool("ae_search_tools", { query: "track a point" }, ctx);
    await callMetaTool("ae_search_tools", { group: "tracking_patching" }, ctx);
    await callMetaTool("ae_search_tools", { pattern: "^ae_track", group: "tracking_patching" }, ctx);
    await callMetaTool("ae_search_tools", { query: "zzzz qqqq nonsense" }, ctx);
    const [q, g, p, none] = await lines();
    expect(q.top).toBe("ae_track_point");
    expect(q.top_score).toBeGreaterThan(4);
    expect(q).not.toHaveProperty("group");
    expect(g).toMatchObject({ group: "tracking_patching" });
    expect(g).not.toHaveProperty("query");
    expect(g).not.toHaveProperty("top");
    expect(p).toMatchObject({ query: "^ae_track", group: "tracking_patching" });
    expect(p).not.toHaveProperty("top_score");
    expect(none.hits).toBe(0);
    expect(none).not.toHaveProperty("top");
  });

  it("writes through an async queue: order kept, everything there after a flush", async () => {
    for (let i = 0; i < 25; i++) recordUsage(ctx, { tool: "t" + i, ms: i, ok: true });
    const all = await lines();
    expect(all.map((l) => l.tool)).toEqual(Array.from({ length: 25 }, (_, i) => "t" + i));
    // The folder is made once; a later line just appends.
    recordUsage(ctx, { tool: "later", ms: 1, ok: true });
    expect((await lines()).at(-1)?.tool).toBe("later");
  });

  it("makes the folder again when it was deleted while running", async () => {
    recordUsage(ctx, { tool: "first", ms: 1, ok: true });
    await flushUsageLog();
    fs.rmSync(path.join(dir, "usage"), { recursive: true, force: true });
    recordUsage(ctx, { tool: "lost", ms: 1, ok: true });
    await flushUsageLog();
    recordUsage(ctx, { tool: "after", ms: 1, ok: true });
    expect((await lines()).map((l) => l.tool)).toEqual(["after"]);
  });

  it("drops the newest lines past the queue limit and counts them", async () => {
    for (let i = 0; i < MAX_QUEUED + 50; i++) recordUsage(ctx, { tool: "t" + i, ms: 1, ok: true });
    expect(droppedUsageLines()).toBeGreaterThan(0);
    const all = await lines();
    expect(all.length + droppedUsageLines()).toBe(MAX_QUEUED + 50);
    expect(all[0].tool).toBe("t0");
  });
});
