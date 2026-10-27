import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  handleRpc,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
} from "../src/mcp-rpc.js";
import { createPanelMcp } from "../src/panel-entry.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";

describe("mcp-rpc and panel-entry", () => {
  const tmpDirs: string[] = [];

  function makeTestContext(
    onEval?: (script: string, label: string) => unknown
  ): {
    ctx: ToolContext;
    calls: Array<{ script: string; label: string }>;
    dataDir: string;
  } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-rpc-"));
    tmpDirs.push(dataDir);
    const calls: Array<{ script: string; label: string }> = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(
      path.join(dataDir, "quarantine.json")
    );
    const bridge = new PanelHost({
      evalScript: async (script, label) => {
        calls.push({ script, label });
        const result = onEval ? await onEval(script, label) : { ok: true };
        return {
          ok: true,
          result,
          durationMs: 5,
        };
      },
      queue,
      quarantine,
    });

    return {
      ctx: { bridge, queue, quarantine },
      calls,
      dataDir,
    };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("negotiates initialize protocolVersion properly", async () => {
    const { ctx } = makeTestContext();

    for (const supported of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const res = (await handleRpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: supported },
        },
        ctx
      )) as JsonRpcSuccessResponse;

      expect(res).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: supported,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "chroma-ae-mcp",
            version: expect.any(String),
          },
        },
      });
    }

    // Unknown protocolVersion falls back to "2025-06-18"
    const fallbackRes = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      },
      ctx
    )) as JsonRpcSuccessResponse;

    expect(
      (fallbackRes.result as { protocolVersion: string }).protocolVersion
    ).toBe("2025-06-18");
  });

  it("returns null for notifications/initialized and other notifications without id", async () => {
    const { ctx } = makeTestContext();

    const initNotif = await handleRpc(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      ctx
    );
    expect(initNotif).toBeNull();

    const customNotif = await handleRpc(
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 99 },
      },
      ctx
    );
    expect(customNotif).toBeNull();
  });

  it("handles ping with empty object result", async () => {
    const { ctx } = makeTestContext();
    const res = await handleRpc(
      {
        jsonrpc: "2.0",
        id: "ping-1",
        method: "ping",
      },
      ctx
    );
    expect(res).toEqual({
      jsonrpc: "2.0",
      id: "ping-1",
      result: {},
    });
  });

  it("lists every tool, core tools first, with object schemas", async () => {
    const { ctx } = makeTestContext();
    expect(ALL_TOOLS).toHaveLength(ALL_TOOLS.length);

    const res = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      },
      ctx
    )) as JsonRpcSuccessResponse;

    const tools = (
      res.result as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: { type: string; properties?: Record<string, unknown> };
        }>;
      }
    ).tools;

    expect(tools).toHaveLength(ALL_TOOLS.length);
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }

    const names = tools.map((t) => t.name);
    expect(names.slice(0, 12)).toEqual([
      "ae_status",
      "ae_get_project",
      "ae_get_comp",
      "ae_get_layer_props",
      "ae_run_jsx",
      "ae_set_property",
      "ae_save",
      "ae_snapshot_frame",
      "ae_render_queue_add",
      "ae_render_queue_status",
      "ae_quarantine_status",
      "ae_acknowledge",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("handles tools/call with valid args and returns isError on bad args", async () => {
    const { ctx, calls } = makeTestContext((script) => {
      if (script.startsWith("__chromaAe.getComp(")) {
        return { id: 10, name: "Hero Comp", width: 1920, height: 1080 };
      }
      if (script.startsWith("__chromaAe.status(")) {
        return { project_path: "<unsaved>", dirty: false };
      }
      return {};
    });

    // Valid tools/call -> ae_get_comp
    const validRes = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "ae_get_comp",
          arguments: { comp_id: 10 },
        },
      },
      ctx
    )) as JsonRpcSuccessResponse;

    const callResult = validRes.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(callResult.isError).toBeUndefined();
    expect(JSON.parse(callResult.content[0].text)).toEqual({
      id: 10,
      name: "Hero Comp",
      width: 1920,
      height: 1080,
    });
    expect(calls[0].script).toBe('__chromaAe.getComp({"comp_id":10})');

    // Valid tools/call -> ae_status with PanelHost (no health() method)
    const statusRes = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "ae_status",
          arguments: {},
        },
      },
      ctx
    )) as JsonRpcSuccessResponse;

    const statusPayload = JSON.parse(
      (
        statusRes.result as {
          content: Array<{ type: string; text: string }>;
        }
      ).content[0].text
    );
    expect(statusPayload.health).toEqual({ ok: true, transport: "panel" });
    expect(statusPayload.project_path).toBe("<unsaved>");

    // Bad arguments -> isError: true
    const badArgsRes = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "ae_get_comp",
          arguments: { comp_id: "not-an-int" },
        },
      },
      ctx
    )) as JsonRpcSuccessResponse;

    const badArgsPayload = badArgsRes.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(badArgsPayload.isError).toBe(true);
    expect(badArgsPayload.content[0].text).toContain("Invalid arguments");

    // Malformed RPC params -> -32602
    const badParamsRes = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { arguments: {} },
      },
      ctx
    )) as JsonRpcErrorResponse;
    expect(badParamsRes.error.code).toBe(-32602);
  });

  it("returns -32601 for unknown method and -32700 for bad JSON", async () => {
    const { ctx } = makeTestContext();

    const unknownRes = (await handleRpc(
      {
        jsonrpc: "2.0",
        id: 404,
        method: "resources/list",
      },
      ctx
    )) as JsonRpcErrorResponse;

    expect(unknownRes).toEqual({
      jsonrpc: "2.0",
      id: 404,
      error: {
        code: -32601,
        message: expect.stringContaining("resources/list"),
      },
    });

    const badJsonRes = (await handleRpc(
      "{not valid json",
      ctx
    )) as JsonRpcErrorResponse;
    expect(badJsonRes.error.code).toBe(-32700);
  });

  it("handles batch arrays and filters out notification nulls", async () => {
    const { ctx } = makeTestContext();

    const batchRes = await handleRpc(
      [
        {
          jsonrpc: "2.0",
          id: "b1",
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        {
          jsonrpc: "2.0",
          id: "b2",
          method: "ping",
        },
      ],
      ctx
    );

    expect(Array.isArray(batchRes)).toBe(true);
    const list = batchRes as JsonRpcSuccessResponse[];
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("b1");
    expect(
      (list[0].result as { protocolVersion: string }).protocolVersion
    ).toBe("2025-03-26");
    expect(list[1]).toEqual({
      jsonrpc: "2.0",
      id: "b2",
      result: {},
    });
  });

  it("serves HTTP via createPanelMcp handleHttp (POST /mcp, GET 405, 202 notification, -32700 parse error)", async () => {
    const { dataDir } = makeTestContext();
    const evalCalls: Array<{ script: string; label: string }> = [];

    const mcp = createPanelMcp({
      dataDir,
      evalScript: async (script, label) => {
        evalCalls.push({ script, label });
        return {
          ok: true,
          result: { id: 5, name: "Test Comp" },
          durationMs: 3,
        };
      },
    });

    function makeMockRes() {
      const headers: Record<string, string> = {};
      let endedBody = "";
      return {
        statusCode: 200,
        writableEnded: false,
        headers,
        get body() {
          return endedBody;
        },
        setHeader(k: string, v: string) {
          headers[k] = v;
        },
        end(body?: string) {
          this.writableEnded = true;
          endedBody = body ?? "";
        },
      };
    }

    // GET /mcp -> 405 with Allow: POST
    const getRes = makeMockRes();
    await mcp.handleHttp({ method: "GET", url: "/mcp" }, getRes, "");
    expect(getRes.statusCode).toBe(405);
    expect(getRes.headers.Allow).toBe("POST");

    // Notification -> 202 empty body
    const notifRes = makeMockRes();
    await mcp.handleHttp(
      { method: "POST", url: "/mcp" },
      notifRes,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    expect(notifRes.statusCode).toBe(202);
    expect(notifRes.body).toBe("");

    // Bad JSON -> -32700
    const badRes = makeMockRes();
    await mcp.handleHttp({ method: "POST", url: "/mcp" }, badRes, "{bad");
    expect(badRes.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(badRes.body)).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });

    // tools/call ae_get_comp -> reaches evalScript with __chromaAe.getComp(...)
    const callRes = makeMockRes();
    await mcp.handleHttp(
      { method: "POST", url: "/mcp" },
      callRes,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: {
          name: "ae_get_comp",
          arguments: { comp_id: 5 },
        },
      })
    );
    expect(callRes.statusCode).toBe(200);
    expect(callRes.headers["Content-Type"]).toBe("application/json");
    expect(evalCalls).toEqual([
      {
        script: '__chromaAe.getComp({"comp_id":5})',
        label: "ae_get_comp(5)",
      },
    ]);
    const parsedCall = JSON.parse(callRes.body) as JsonRpcSuccessResponse;
    expect(parsedCall.id).toBe(77);
  });
});
