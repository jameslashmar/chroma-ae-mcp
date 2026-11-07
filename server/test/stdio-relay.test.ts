import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpc } from "../src/mcp-rpc.js";
import type { ToolContext } from "../src/tools/common.js";

const RELAY = path.resolve(__dirname, "../../panel/tools/stdio-relay.cjs");
const TOOLS = [{ name: "ae_status", description: "status", inputSchema: { type: "object" } }];

const tmpDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((r) => s.close(r));
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A home dir for the relay, holding the token where the panel writes it. */
function home(token = "secret-token") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-relay-"));
  tmpDirs.push(dir);
  let dataDir: string;
  if (process.platform === "win32") {
    dataDir = path.join(dir, "chroma-ae-mcp");
  } else if (process.platform === "darwin") {
    dataDir = path.join(dir, "Library", "Application Support", "chroma-ae-mcp");
  } else {
    dataDir = path.join(dir, ".local", "share", "chroma-ae-mcp");
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "token"), token + "\n");
  return { dir, dataDir };
}

interface Seen {
  auth: string | undefined;
  toolset: string | undefined;
  body: any;
}

/** A stand-in for the panel's /mcp endpoint. */
async function fakePanel(reply: (body: any) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text);
      seen.push({ auth: req.headers.authorization, toolset: req.headers["x-chroma-toolset"] as string | undefined, body });
      const out = reply(body);
      res.statusCode = out.status;
      if (out.body === undefined) {
        res.end("");
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(out.body));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** A port with nothing listening, as when AE is closed. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise((r) => server.close(r));
  return port;
}

async function runRelay(
  homeDir: string,
  port: number,
  messages: unknown[],
  opts: { toolset?: string; stderr?: string[] } = {}
): Promise<any[]> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.CHROMA_AE_MCP_TOOLSET;
  const child = childProcess.spawn(process.execPath, [RELAY], {
    env: {
      ...baseEnv,
      ...(opts.toolset !== undefined ? { CHROMA_AE_MCP_TOOLSET: opts.toolset } : {}),
      LOCALAPPDATA: homeDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CHROMA_AE_MCP_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const code = await new Promise((r) => child.on("close", r));
  expect(code).toBe(0);
  if (opts.stderr) opts.stderr.push(...err.split("\n").filter((l) => l.trim()));
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

const initialize = (id: number, protocolVersion = "2025-06-18") => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } },
});
const listTools = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const callStatus = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "ae_status", arguments: {} },
});

// Each test spawns the relay as a child process; under a full parallel run that
// takes longer than vitest's 5 s default.
describe("panel/tools/stdio-relay.cjs", { timeout: 20000 }, () => {
  it("forwards each message with the token from the data dir and caches the tool list", async () => {
    const { dir, dataDir } = home("tok-123");
    const panel = await fakePanel((body) => {
      if (body.id === undefined) return { status: 202 };
      if (body.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } } };
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { echo: body.method } } };
    });

    const replies = await runRelay(dir, panel.port, [
      initialize(1),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      listTools(2),
      callStatus(3),
    ]);

    expect(panel.seen.map((s) => s.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(panel.seen.every((s) => s.auth === "Bearer tok-123")).toBe(true);
    // The notification's 202 sends nothing back.
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[0].result).toEqual({ echo: "initialize" });
    expect(replies[1].result.tools).toEqual(TOOLS);
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, "relay-tools-cache.json"), "utf8"));
    expect(cache.tools).toEqual(TOOLS);
  });

  it("keeps the tools registered while AE is closed, and calls say to start AE", async () => {
    const { dir, dataDir } = home();
    const PROMPTS = [{ name: "motion_director", description: "d" }];
    fs.writeFileSync(path.join(dataDir, "relay-tools-cache.json"), JSON.stringify({ tools: TOOLS }));
    fs.writeFileSync(path.join(dataDir, "relay-prompts-cache.json"), JSON.stringify({ prompts: PROMPTS }));

    const replies = await runRelay(dir, await closedPort(), [
      initialize(1, "2025-03-26"),
      listTools(2),
      callStatus(3),
      { jsonrpc: "2.0", id: 4, method: "completion/complete" },
      { jsonrpc: "2.0", id: 5, method: "prompts/list" },
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "chroma-ae://guidance/motion-director/SKILL.md" } },
    ]);

    expect(replies[0].result.protocolVersion).toBe("2025-03-26");
    expect(replies[0].result.serverInfo.name).toBe("chroma-ae-mcp");
    // The panel's capabilities, so prompts and resources stay registered while AE is closed.
    expect(Object.keys(replies[0].result.capabilities).sort()).toEqual(["prompts", "resources", "tools"]);
    expect(replies[1].result.tools).toEqual(TOOLS);
    expect(replies[2].result.isError).toBe(true);
    expect(replies[2].result.content[0].text).toMatch(/Start After Effects/);
    // Unknown to the relay altogether: method not found. Known methods that need the panel: -32000.
    expect(replies[3].error.code).toBe(-32601);
    expect(replies[4].result.prompts).toEqual(PROMPTS);
    // Never listed by the panel yet: an empty list rather than an error.
    expect(replies[5].result.resources).toEqual([]);
    expect(replies[6].error.code).toBe(-32000);
    expect(replies[6].error.message).toMatch(/not reachable/);
  });

  it("caches the prompt and resource lists the panel serves, beside the tool list", async () => {
    const { dir, dataDir } = home();
    fs.writeFileSync(path.join(dataDir, "relay-tools-cache.json"), JSON.stringify({ tools: TOOLS }));
    const PROMPTS = [{ name: "motion_review" }];
    const panel = await fakePanel((body) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result: { prompts: PROMPTS } } }));
    const replies = await runRelay(dir, panel.port, [{ jsonrpc: "2.0", id: 1, method: "prompts/list" }]);
    expect(replies[0].result.prompts).toEqual(PROMPTS);
    const prompts = JSON.parse(fs.readFileSync(path.join(dataDir, "relay-prompts-cache.json"), "utf8"));
    expect(prompts).toEqual({ prompts: PROMPTS });
    // One file per key: the tools file is untouched, and no temp file is left behind.
    const tools = JSON.parse(fs.readFileSync(path.join(dataDir, "relay-tools-cache.json"), "utf8"));
    expect(tools).toEqual({ tools: TOOLS });
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("serves prompts/get and resources/read while AE is closed, from the text the panel served", async () => {
    const { dir, dataDir } = home();
    const ctx = {} as ToolContext;
    // The real MCP handler stands in for the panel, so the cached text is exactly what it serves.
    const server = http.createServer((req, res) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", async () => {
        const out = await handleRpc(JSON.parse(text), ctx);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    await runRelay(dir, port, [{ jsonrpc: "2.0", id: 1, method: "prompts/list" }]);
    expect(fs.existsSync(path.join(dataDir, "relay-contents-cache.json"))).toBe(true);
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const skill = "chroma-ae://guidance/motion-director/SKILL.md";
    const asks = [
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: skill } },
      { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "motion_director" } },
      { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "motion_director", arguments: { task: "  a 6 s logo sting " } } },
      { jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "motion_review", arguments: { comp: "Main" } } },
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "chroma-ae://guidance/nope.md" } },
      { jsonrpc: "2.0", id: 6, method: "prompts/get", params: { name: "nope" } },
    ];
    const offline = await runRelay(dir, await closedPort(), asks);
    for (const i of [0, 1, 2, 3]) {
      const online = (await handleRpc(asks[i], ctx)) as any;
      expect(offline[i].result).toEqual(online.result);
    }
    expect(offline[2].result.messages[0].content.text).toMatch(/Task: a 6 s logo sting\n$/);
    expect(offline[4].error.code).toBe(-32002);
    expect(offline[5].error.code).toBe(-32602);
  });

  it("reports the version in VERSION when offline", async () => {
    const { dir } = home();
    const version = fs.readFileSync(path.resolve(__dirname, "../../VERSION"), "utf8").trim();
    const replies = await runRelay(dir, await closedPort(), [initialize(1)]);
    expect(replies[0].result.serverInfo.version).toBe(version);
  });

  it("answers null and non-object lines with -32600 and does not forward them", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result: {} } }));
    const child = childProcess.spawn(process.execPath, [RELAY], {
      env: { ...process.env, LOCALAPPDATA: dir, HOME: dir, USERPROFILE: dir, CHROMA_AE_MCP_PORT: String(panel.port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.end('null\n42\n"x"\n');
    await new Promise((r) => child.on("close", r));
    const replies = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(replies).toHaveLength(3);
    expect(replies.every((r) => r.id === null && r.error.code === -32600)).toBe(true);
    expect(panel.seen).toHaveLength(0);
  });

  it("reports an error for tools/list when AE is closed and no list is cached", async () => {
    const { dir } = home();
    const replies = await runRelay(dir, await closedPort(), [initialize(1, "1999-01-01"), listTools(2)]);
    expect(replies[0].result.protocolVersion).toBe("2025-06-18");
    expect(replies[1].error.message).toMatch(/not reachable/);
  });

  it("turns a rejected token into a readable tool error", async () => {
    const { dir } = home();
    const panel = await fakePanel(() => ({ status: 401, body: { ok: false, error: { kind: "auth" } } }));
    const replies = await runRelay(dir, panel.port, [callStatus(1)]);
    expect(replies[0].result.isError).toBe(true);
    expect(replies[0].result.content[0].text).toMatch(/rejected the token/);
  });

  // ---------- toolsets ----------

  const CORE_TOOLS = [
    { name: "ae_search_tools", description: "s", inputSchema: { type: "object" } },
    { name: "ae_status", description: "status", inputSchema: { type: "object" } },
  ];
  const listReply = (body: any) => {
    if (body.id === undefined) return { status: 202 };
    if (body.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { tools: CORE_TOOLS } } };
    if (body.method === "initialize") {
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", instructions: "CORE INSTRUCTIONS", serverInfo: {} } } };
    }
    return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: {} } };
  };

  it("sends X-Chroma-Toolset: core on every request when CHROMA_AE_MCP_TOOLSET=core", async () => {
    const { dir } = home();
    const panel = await fakePanel(listReply);
    await runRelay(dir, panel.port, [initialize(1), { jsonrpc: "2.0", method: "notifications/initialized" }, listTools(2), callStatus(3)], { toolset: "core" });
    expect(panel.seen).toHaveLength(4);
    expect(panel.seen.every((s) => s.toolset === "core")).toBe(true);
  });

  it("sends no toolset header when the variable is unset, empty or full", async () => {
    for (const toolset of [undefined, "", "full", "FULL"]) {
      const { dir } = home();
      const panel = await fakePanel(listReply);
      await runRelay(dir, panel.port, [initialize(1), listTools(2)], { toolset });
      expect(panel.seen.map((s) => s.toolset), String(toolset)).toEqual([undefined, undefined]);
    }
  });

  it("treats a bad value as full and says so once on stderr", async () => {
    const { dir } = home();
    const panel = await fakePanel(listReply);
    const stderr: string[] = [];
    await runRelay(dir, panel.port, [initialize(1), listTools(2), listTools(3)], { toolset: "tiny", stderr });
    expect(panel.seen.every((s) => s.toolset === undefined)).toBe(true);
    const notes = stderr.filter((l) => l.includes("CHROMA_AE_MCP_TOOLSET"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("tiny");
  });

  it("keeps a separate tools cache for the core toolset, so switching never shows the wrong list", async () => {
    const { dir, dataDir } = home();
    const panel = await fakePanel(listReply);
    await runRelay(dir, panel.port, [listTools(1)], { toolset: "core" });
    const corePath = path.join(dataDir, "relay-tools-core-cache.json");
    expect(JSON.parse(fs.readFileSync(corePath, "utf8"))).toEqual({ tools: CORE_TOOLS });
    // The full-list cache keeps its name and was not touched.
    expect(fs.existsSync(path.join(dataDir, "relay-tools-cache.json"))).toBe(false);

    fs.writeFileSync(path.join(dataDir, "relay-tools-cache.json"), JSON.stringify({ tools: TOOLS }));
    const closed = await closedPort();
    const offlineCore = await runRelay(dir, closed, [listTools(1)], { toolset: "core" });
    expect(offlineCore[0].result.tools).toEqual(CORE_TOOLS);
    const offlineFull = await runRelay(dir, closed, [listTools(1)]);
    expect(offlineFull[0].result.tools).toEqual(TOOLS);
    // Core with no core cache yet does not fall back to the full list.
    fs.rmSync(corePath);
    const none = await runRelay(dir, closed, [listTools(1)], { toolset: "core" });
    expect(none[0].error).toBeTruthy();
  });

  it("hands the cached core instructions to the client while AE is closed", async () => {
    const { dir, dataDir } = home();
    const panel = await fakePanel(listReply);
    const online = await runRelay(dir, panel.port, [initialize(1)], { toolset: "core" });
    expect(online[0].result.instructions).toBe("CORE INSTRUCTIONS");
    const offline = await runRelay(dir, await closedPort(), [initialize(1)], { toolset: "core" });
    expect(offline[0].result.instructions).toBe("CORE INSTRUCTIONS");
    const offlineFull = await runRelay(dir, await closedPort(), [initialize(1)]);
    expect(offlineFull[0].result).not.toHaveProperty("instructions");
    expect(fs.existsSync(path.join(dataDir, "relay-instructions-core-cache.json"))).toBe(true);
  });

  it("survives an older panel that ignores the header: its full list passes through and is not cached as core", async () => {
    const { dir, dataDir } = home();
    const panel = await fakePanel((body) => {
      if (body.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } } };
      return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: { echo: body.method } } };
    });
    const stderr: string[] = [];
    const replies = await runRelay(dir, panel.port, [initialize(1), listTools(2), callStatus(3)], { toolset: "core", stderr });
    expect(replies[0].result).toEqual({ echo: "initialize" });
    expect(replies[1].result.tools).toEqual(TOOLS);
    expect(replies[2].result).toEqual({ echo: "tools/call" });
    expect(fs.existsSync(path.join(dataDir, "relay-tools-core-cache.json"))).toBe(false);
    expect(stderr.some((l) => l.includes("does not know the core toolset"))).toBe(true);
  });

  it("passes the real core list from the MCP handler through and caches it as core", async () => {
    const { dir, dataDir } = home();
    const real = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {} as ToolContext, { toolset: "core" })) as any;
    const list = real.result.tools as Array<{ name: string }>;
    const server = await fakePanel((body) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result: { tools: list } } }));
    const replies = await runRelay(dir, server.port, [listTools(1)], { toolset: "core" });
    expect(replies[0].result.tools.map((t: any) => t.name)).toEqual(list.map((t) => t.name));
    const cached = JSON.parse(fs.readFileSync(path.join(dataDir, "relay-tools-core-cache.json"), "utf8"));
    expect(cached.tools).toHaveLength(35);
  });
});
