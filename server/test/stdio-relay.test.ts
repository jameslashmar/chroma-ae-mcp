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
  client: string | undefined;
  body: any;
  headers: http.IncomingHttpHeaders;
}

/** A stand-in for the panel's /mcp endpoint. */
async function fakePanel(reply: (body: any) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text);
      seen.push({ auth: req.headers.authorization, toolset: req.headers["x-chroma-toolset"] as string | undefined, client: req.headers["x-chroma-client"] as string | undefined, body, headers: req.headers });
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
  opts: { toolset?: string; stderr?: string[]; diagnose?: "off" | "quick" | "default"; relay?: string; env?: Record<string, string> } = {}
): Promise<any[]> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.CHROMA_AE_MCP_TOOLSET;
  delete baseEnv.CHROMA_AE_MCP_DIAGNOSE;
  delete baseEnv.CHROMA_AE_MCP_DIAGNOSE_BUDGET_MS;
  // Windows env names are case-insensitive, and Git Bash upper-cases them (COMMONPROGRAMFILES(X86)).
  // Drop every spelling of the keys overridden below, or the child gets both and the real one can win.
  const overridden = ["LOCALAPPDATA", "APPDATA", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMFILES", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT"];
  for (const k of Object.keys(baseEnv)) if (overridden.includes(k.toUpperCase())) delete baseEnv[k];
  const child = childProcess.spawn(process.execPath, [opts.relay ?? RELAY], {
    env: {
      ...baseEnv,
      ...(opts.toolset !== undefined ? { CHROMA_AE_MCP_TOOLSET: opts.toolset } : {}),
      // The tests written before the relay diagnosed an unreachable panel pin its old one-line text.
      // The diagnosis has its own tests below, in quick mode (no process is started, no real AE is looked at).
      ...((opts.diagnose ?? "off") === "default" ? {} : { CHROMA_AE_MCP_DIAGNOSE: opts.diagnose ?? "off" }),
      ...(opts.env ?? {}),
      LOCALAPPDATA: homeDir,
      APPDATA: homeDir,
      "CommonProgramFiles(x86)": homeDir,
      CommonProgramFiles: homeDir,
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

const initialize = (id: number, protocolVersion = "2025-06-18", clientName: unknown = "test") => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: clientName, version: "1" } },
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
    ], { toolset: "full" });

    // The relay sends each line as its own request, at once (a real client waits for initialize first), so they can arrive in any order.
    expect(panel.seen.map((s) => s.body.method).sort()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/list",
    ]);
    expect(panel.seen.every((s) => s.auth === "Bearer tok-123")).toBe(true);
    // The notification's 202 sends nothing back.
    const byId = [...replies].sort((x, y) => x.id - y.id);
    expect(byId.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(byId[0].result).toEqual({ echo: "initialize" });
    expect(byId[1].result.tools).toEqual(TOOLS);
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

  // ---------- why the panel cannot be reached ----------

  /** Puts the panel where CEP looks for it in the temp home, so "not installed" does not win. */
  function installPanel(dir: string) {
    const ext =
      process.platform === "win32"
        ? path.join(dir, "Adobe", "CEP", "extensions", "london.chroma.aemcp")
        : path.join(dir, "Library", "Application Support", "Adobe", "CEP", "extensions", "london.chroma.aemcp");
    fs.mkdirSync(path.join(ext, "CSXS"), { recursive: true });
    fs.writeFileSync(path.join(ext, "CSXS", "manifest.xml"), '<x ExtensionBundleVersion="0.6.0"/>');
  }

  it("a tool call with the panel not installed says so, and says Connected, not READY", async () => {
    const { dir } = home();
    const stderr: string[] = [];
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { diagnose: "quick", stderr });
    const text = replies[0].result.content[0].text as string;
    expect(replies[0].result.isError).toBe(true);
    expect(text).toMatch(/panel is not installed/);
    expect(text).toMatch(/install-dev.ps1/);
    expect(text).not.toMatch(/READY/);
    expect(stderr.some((l) => l.includes("panel_not_installed"))).toBe(true);
    expect(stderr.join(" ")).not.toContain("secret-token");
  });

  it("a tool call with the panel installed but the service down says to open the panel", async () => {
    const { dir } = home();
    installPanel(dir);
    const port = await closedPort();
    const replies = await runRelay(dir, port, [callStatus(1)], { diagnose: "quick" });
    const text = replies[0].result.content[0].text as string;
    expect(text).toContain(`not listening on 127.0.0.1:${port}`);
    expect(text).toMatch(/Open Window > Extensions > Chroma AE MCP once/);
  });

  it("a tool call before the service ever ran says it has never started", async () => {
    const { dir, dataDir } = home();
    fs.rmSync(path.join(dataDir, "token"));
    installPanel(dir);
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { diagnose: "quick" });
    expect(replies[0].result.content[0].text).toMatch(/never started on this machine/);
  });

  it("initialize, ping and the list calls are not diagnosed: they stay instant and keep the short text", async () => {
    const { dir } = home();
    const stderr: string[] = [];
    const t0 = Date.now();
    const replies = await runRelay(dir, await closedPort(), [initialize(1), { jsonrpc: "2.0", id: 2, method: "ping" }, listTools(3)], { diagnose: "quick", stderr });
    expect(replies[0].result.serverInfo.name).toBe("chroma-ae-mcp");
    expect(replies[1].result).toEqual({});
    expect(replies[2].error.message).toMatch(/not reachable/);
    expect(replies[2].error.message).toMatch(/shows Connected/);
    // Nothing was diagnosed for them (no stderr line, no process spawn); generous bound for a loaded machine.
    expect(stderr.filter((l) => /panel_not_installed|service_down|no_token/.test(l))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it("CHROMA_AE_MCP_DIAGNOSE=off keeps the old one-line text for a tool call", async () => {
    const { dir } = home();
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { diagnose: "off" });
    expect(replies[0].result.content[0].text).toMatch(/Start After Effects and wait until Window > Extensions > Chroma AE MCP shows Connected/);
  });

  it("a rejected token on a tool call is diagnosed as token_rejected, with the service's own /health asked", async () => {
    const { dir } = home();
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: { kind: "auth" } }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const replies = await runRelay(dir, port, [callStatus(1)], { diagnose: "quick" });
    expect(replies[0].result.isError).toBe(true);
    expect(replies[0].result.content[0].text).toMatch(/rejected the token/);
    expect(replies[0].result.content[0].text).toMatch(/Regenerate the token/);
    expect(paths).toContain("POST /mcp");
    expect(paths).toContain("GET /health");
  });

  // ---------- the default path, end to end ----------

  it("the default path (no env switch) starts the real probes and still answers a tool call with a decided reason", async () => {
    const { dir } = home();
    const stderr: string[] = [];
    const t0 = Date.now();
    // The temp home has no panel and the port is closed. Whatever runs on this machine, the answer is a decided reason.
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { diagnose: "default", stderr });
    const text = replies[0].result.content[0].text as string;
    expect(replies[0].result.isError).toBe(true);
    expect(text).toMatch(/^Chroma AE MCP: /);
    expect(text).not.toMatch(/READY/);
    expect(stderr.some((l) => /^\[chroma-ae relay\] [a-z_]+: Chroma AE MCP: /.test(l))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15000);
  });

  it("when the diagnosis finds the service answering after all (res.ok), the old text is kept", async () => {
    const { dir } = home();
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/health") {
          res.end(JSON.stringify({ ok: true, startedBy: "service", aeVersion: "26.0", instance: { pid: 5, ae_label: "2026" } }));
        } else {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: { kind: "auth" } }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const replies = await runRelay(dir, port, [callStatus(1)], { diagnose: "quick" });
    expect(seen).toContain("GET /health");
    expect(replies[0].result.content[0].text).toMatch(/rejected the token in .*make sure no AfterFX.exe is left in Task Manager/);
  });

  /** A copy of the relay beside a stand-in relay-diagnose.cjs, so the hook runs against a diagnosis we control. */
  function relayWithDiagnose(stub: string) {
    const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-relaycopy-"));
    tmpDirs.push(toolsDir);
    fs.copyFileSync(RELAY, path.join(toolsDir, "stdio-relay.cjs"));
    fs.writeFileSync(path.join(toolsDir, "relay-diagnose.cjs"), stub);
    return path.join(toolsDir, "stdio-relay.cjs");
  }

  it("a diagnosis that does not finish within the budget falls back to the old text, and the relay still exits", async () => {
    const { dir } = home();
    const relay = relayWithDiagnose("module.exports = { diagnose: () => new Promise(() => {}) };");
    const t0 = Date.now();
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { relay, diagnose: "default", env: { CHROMA_AE_MCP_DIAGNOSE_BUDGET_MS: "300" } });
    expect(replies[0].result.content[0].text).toMatch(/Start After Effects and wait until Window > Extensions > Chroma AE MCP shows Connected/);
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it("CHROMA_AE_MCP_DIAGNOSE_BUDGET_MS can only lower the budget: a huge value still gives up at 6 s", async () => {
    const { dir } = home();
    const relay = relayWithDiagnose("module.exports = { diagnose: () => new Promise(() => {}) };");
    const t0 = Date.now();
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { relay, diagnose: "default", env: { CHROMA_AE_MCP_DIAGNOSE_BUDGET_MS: "600000" } });
    expect(replies[0].result.content[0].text).toMatch(/Start After Effects and wait until Window > Extensions > Chroma AE MCP shows Connected/);
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 20_000);

  it("a diagnosis that throws falls back to the old text", async () => {
    const { dir } = home();
    const relay = relayWithDiagnose("module.exports = { diagnose: () => { throw new Error('boom'); } };");
    const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { relay });
    expect(replies[0].result.content[0].text).toMatch(/Start After Effects and wait/);
  });

  it("a diagnosis that finds nothing wrong (ok) or says nothing keeps the old text too", async () => {
    const { dir } = home();
    const ok = relayWithDiagnose("module.exports = { diagnose: async () => ({ ok: true, code: 'ok', message: 'fine', fix: [] }) };");
    const empty = relayWithDiagnose("module.exports = { diagnose: async () => ({ ok: false, code: 'x', message: '', fix: [] }) };");
    for (const relay of [ok, empty]) {
      const replies = await runRelay(dir, await closedPort(), [callStatus(1)], { relay });
      expect(replies[0].result.content[0].text).toMatch(/Start After Effects and wait/);
    }
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

  it("sends full when the variable says full, and core when it is empty (the panel's default is core)", async () => {
    for (const [toolset, sent] of [["full", "full"], ["FULL", "full"], ["", "core"]]) {
      const { dir } = home();
      const panel = await fakePanel(listReply);
      await runRelay(dir, panel.port, [initialize(1), listTools(2)], { toolset });
      expect(panel.seen.map((s) => s.toolset), String(toolset)).toEqual([sent, sent]);
    }
  });

  it("treats a bad value as core and says so once on stderr", async () => {
    const { dir } = home();
    const panel = await fakePanel(listReply);
    const stderr: string[] = [];
    await runRelay(dir, panel.port, [initialize(1), listTools(2), listTools(3)], { toolset: "tiny", stderr });
    expect(panel.seen.every((s) => s.toolset === "core")).toBe(true);
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
    const offlineFull = await runRelay(dir, closed, [listTools(1)], { toolset: "full" });
    expect(offlineFull[0].result.tools).toEqual(TOOLS);
    // Core with no core cache yet (an upgrader from 0.7.0): the full cache answers, with one log line.
    fs.rmSync(corePath);
    const stderr: string[] = [];
    const upgraded = await runRelay(dir, closed, [listTools(1), listTools(2)], { toolset: "core", stderr });
    expect(upgraded[0].result.tools).toEqual(TOOLS);
    expect(upgraded[1].result.tools).toEqual(TOOLS);
    expect(stderr.filter((l) => l.includes("no core tools cache yet"))).toHaveLength(1);
    // With neither cache there is still an error.
    fs.rmSync(path.join(dataDir, "relay-tools-cache.json"));
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
    const offlineFull = await runRelay(dir, await closedPort(), [initialize(1)], { toolset: "full" });
    expect(offlineFull[0].result).not.toHaveProperty("instructions");
    expect(fs.existsSync(path.join(dataDir, "relay-instructions-core-cache.json"))).toBe(true);
  });

  describe("toolset by client name (CHROMA_AE_MCP_TOOLSET unset)", () => {
    const run = async (clientName: unknown, toolset?: string, stderr?: string[]) => {
      const { dir } = home();
      const panel = await fakePanel(listReply);
      await runRelay(dir, panel.port, [initialize(1, "2025-06-18", clientName), listTools(2), callStatus(3)], { toolset, stderr });
      return panel.seen;
    };

    it("gives claude-ai, the Store build's local-agent-mode name, cursor, unknown and missing names the core toolset", async () => {
      for (const name of ["claude-ai", "Claude-AI", "local-agent-mode-chroma-ae", "cursor", "codex-mcp-client", "something-new", "claude-code-extra", "", undefined, 42]) {
        const seen = await run(name);
        expect(seen.map((s) => s.toolset), String(name)).toEqual(["core", "core", "core"]);
      }
    });

    it("gives claude-code (any case) the core list too: it sent every full-list schema with each request (measured)", async () => {
      for (const name of ["claude-code", "Claude-Code", "CLAUDE-CODE"]) {
        const seen = await run(name);
        expect(seen.map((s) => s.toolset), name).toEqual(["core", "core", "core"]);
      }
    });

    it("lets the environment choose full", async () => {
      expect((await run("claude-ai", "full")).map((s) => s.toolset)).toEqual(["full", "full", "full"]);
      expect((await run("claude-code", "full")).map((s) => s.toolset)).toEqual(["full", "full", "full"]);
      expect((await run("cursor", "core")).map((s) => s.toolset)).toEqual(["core", "core", "core"]);
      expect((await run("claude-ai", "")).map((s) => s.toolset)).toEqual(["core", "core", "core"]);
    });

    it("treats an invalid environment value as core and logs it once", async () => {
      const stderr: string[] = [];
      const seen = await run("claude-ai", "bogus", stderr);
      expect(seen.map((s) => s.toolset)).toEqual(["core", "core", "core"]);
      expect(stderr.filter((l) => l.includes("is not 'core' or 'full'"))).toHaveLength(1);
    });

    it("logs the choice once, with the client name and the reason", async () => {
      const cases: Array<[unknown, string | undefined, string]> = [
        ["claude-ai", undefined, 'toolset core (default core); client "claude-ai"'],
        ["local-agent-mode-chroma-ae", undefined, 'toolset core (default core); client "local-agent-mode-chroma-ae"'],
        ["cursor", undefined, 'toolset core (default core); client "cursor"'],
        ["claude-code", undefined, 'toolset core (default core); client "claude-code"'],
        ["cursor", "core", 'toolset core (env); client "cursor"'],
        ["claude-ai", "full", 'toolset full (env); client "claude-ai"'],
      ];
      for (const [name, toolset, line] of cases) {
        const stderr: string[] = [];
        await run(name, toolset, stderr);
        const lines = stderr.filter((l) => l.includes("toolset ") && l.includes("client "));
        expect(lines, String(name)).toHaveLength(1);
        expect(lines[0]).toContain(line);
      }
    });

    it("uses the core list before any initialize", async () => {
      const { dir } = home();
      const panel = await fakePanel(listReply);
      await runRelay(dir, panel.port, [listTools(1)]);
      expect(panel.seen.map((s) => s.toolset)).toEqual(["core"]);
      expect(panel.seen[0].client).toBeUndefined();
    });

    it("answers the offline initialize by the same rule", async () => {
      const { dir } = home();
      const panel = await fakePanel(listReply);
      await runRelay(dir, panel.port, [initialize(1, "2025-06-18", "claude-ai"), listTools(2)]);
      const closed = await closedPort();
      const desktop = await runRelay(dir, closed, [initialize(1, "2025-06-18", "claude-ai"), listTools(2)]);
      expect(desktop[0].result.instructions).toBe("CORE INSTRUCTIONS");
      expect(desktop[1].result.tools).toEqual(CORE_TOOLS);
      const cursor = await runRelay(dir, closed, [initialize(1, "2025-06-18", "cursor")]);
      expect(cursor[0].result.instructions).toBe("CORE INSTRUCTIONS");
      const code = await runRelay(dir, closed, [initialize(1, "2025-06-18", "claude-code")]);
      expect(code[0].result.instructions).toBe("CORE INSTRUCTIONS");
    });

    it("sends X-Chroma-Client on every request after the initialize, sanitised and at most 40 characters", async () => {
      const seen = await run("cursor");
      expect(seen.map((s) => s.client)).toEqual(["cursor", "cursor", "cursor"]);
      const messy = await run("Evil\r\nX-Injected: 1 " + "x".repeat(80) + "\u00e9");
      const sent = messy[0].client as string;
      expect(sent.length).toBeLessThanOrEqual(40);
      expect(sent).toMatch(/^[ -~]+$/);
      expect(sent.startsWith("Evil X-Injected: 1 xxx")).toBe(true);
      expect(messy.every((s) => s.client === sent)).toBe(true);
    });
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
    expect(cached.tools).toHaveLength(37);
  });
});

describe("panel/tools/stdio-relay.cjs: progress over an event stream", { timeout: 20000 }, () => {
  it("asks for an event stream, passes progress notifications on as they come, then the result", async () => {
    const { dir } = home();
    let accept = "";
    const server = http.createServer((req, res) => {
      accept = String(req.headers.accept ?? "");
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        const body = JSON.parse(text);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        const ev = (m: unknown) => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
        ev({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1, message: "frame 1" } });
        ev({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 2, message: "frame 2" } });
        ev({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{\"ok\":true}" }] } });
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const out = await runRelay(dir, port, [{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ae_status", arguments: {}, _meta: { progressToken: "t" } } }]);
    expect(accept).toMatch(/text\/event-stream/);
    const progress = out.filter((m) => m.method === "notifications/progress");
    expect(progress.map((m) => m.params.message)).toEqual(["frame 1", "frame 2"]);
    expect(out.find((m) => m.id === 4)?.result.content[0].text).toBe("{\"ok\":true}");
  });
});

describe("panel/tools/stdio-relay.cjs: elicitation", { timeout: 20000 }, () => {
  it("tells the panel the client elicits, passes the panel's question on, and the client's answer back", async () => {
    const { dir } = home();
    const headers: string[] = [];
    let answer: any = null;
    let finish: (() => void) | null = null;
    const server = http.createServer((req, res) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        const body = JSON.parse(text);
        if (body.method === "initialize") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "1" } } }));
          return;
        }
        if (body.method === undefined) {
          // The client's answer to our question.
          answer = body;
          res.statusCode = 202;
          res.end("");
          finish?.();
          return;
        }
        headers.push(String(req.headers["x-chroma-elicitation"] ?? ""));
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "chroma-srv-1", method: "elicitation/create", params: { message: "Which?", requestedSchema: { type: "object", properties: {} } } })}\n\n`);
        const done = () => {
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ got: answer?.result?.action }) }] } })}\n\n`);
          res.end();
        };
        if (answer) done();
        else finish = done;
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "1" } } };
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ae_ask_user", arguments: {} } };
    const reply = { jsonrpc: "2.0", id: "chroma-srv-1", result: { action: "accept", content: { choice: "a" } } };
    const out = await runRelay(dir, port, [init, call, reply]);
    expect(headers).toEqual(["1"]);
    expect(out.some((m) => m.method === "elicitation/create" && m.id === "chroma-srv-1")).toBe(true);
    expect(answer).toMatchObject({ id: "chroma-srv-1", result: { action: "accept" } });
    expect(JSON.parse(out.find((m) => m.id === 2).result.content[0].text)).toEqual({ got: "accept" });
    expect(out.some((m) => m.id === "chroma-srv-1" && m.error)).toBe(false); // nothing answered back for the client's own reply
  });
});

// ---------- MCP 2026-07-28 and the Skills extension ----------

const PV = "io.modelcontextprotocol/protocolVersion";
const CAPS = "io.modelcontextprotocol/clientCapabilities";
const CINFO = "io.modelcontextprotocol/clientInfo";
const SINFO = "io.modelcontextprotocol/serverInfo";
const ALL_VERSIONS = ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The _meta of a modern request. */
const mmeta = (extra: Record<string, unknown> = {}) => ({ [PV]: "2026-07-28", [CAPS]: {}, [CINFO]: { name: "modern-client", version: "1" }, ...extra });
const modern = (id: number, method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = mmeta()) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: { ...params, _meta: meta },
});
const ok = (body: any, result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result } });
/** The decoded Mcp-Name: the Base64 sentinel form (=?base64?...?=) is decoded as the panel does. */
const decodeSentinel = (v: string | undefined) => {
  const m = /^=\?base64\?(.*)\?=$/.exec(v ?? "");
  return m ? Buffer.from(m[1], "base64").toString("utf8") : v;
};

const SKILL_URI = "skill://captions/SKILL.md";
const SKILL_REF = "skill://captions/references/rules.md";
const SKILLS = [
  {
    uri: SKILL_URI,
    frontmatter: { name: "captions", description: "Make captions." },
    resources: [
      { uri: SKILL_URI, digest: "sha256:" + "a".repeat(64), size: 10 },
      { uri: SKILL_REF, digest: "sha256:" + "b".repeat(64), size: 20 },
    ],
  },
];
const SKILL_TEXT: Record<string, string> = { [SKILL_URI]: "# Captions\n", [SKILL_REF]: "# Rules\n" };
const skillContents = (uri: string) => [{ uri, mimeType: "text/markdown", text: SKILL_TEXT[uri] }];

describe("panel/tools/stdio-relay.cjs: MCP 2026-07-28", { timeout: 20000 }, () => {
  it("sends MCP-Protocol-Version, Mcp-Method and Mcp-Name for the requests that name something", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ok(body, {}));
    await runRelay(dir, panel.port, [
      modern(1, "server/discover"),
      modern(2, "tools/call", { name: "ae_status", arguments: {} }),
      modern(3, "prompts/get", { name: "motion_director" }),
      modern(4, "resources/read", { uri: "chroma-ae://guidance/motion-director/SKILL.md" }),
      modern(5, "tools/list"),
    ]);
    const by = (m: string) => panel.seen.find((s) => s.body.method === m)!;
    for (const s of panel.seen) {
      expect(s.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(s.headers["mcp-method"]).toBe(s.body.method);
      expect(s.headers["x-chroma-elicitation"]).toBeUndefined();
      expect(s.headers["x-chroma-toolset"]).toBe("core");
    }
    expect(by("server/discover").headers["mcp-name"]).toBeUndefined();
    expect(by("tools/list").headers["mcp-name"]).toBeUndefined();
    expect(by("tools/call").headers["mcp-name"]).toBe("ae_status");
    expect(by("prompts/get").headers["mcp-name"]).toBe("motion_director");
    expect(by("resources/read").headers["mcp-name"]).toBe("chroma-ae://guidance/motion-director/SKILL.md");
  });

  it("encodes a Mcp-Name that is not plain printable ASCII as =?base64?...?=, and one that looks like the sentinel", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ok(body, {}));
    const names = ["café テスト", " padded ", "=?base64?abc?=", "plain_name"];
    await runRelay(dir, panel.port, names.map((name, i) => modern(i + 1, "tools/call", { name, arguments: {} })));
    const sent = new Map(panel.seen.map((s) => [s.body.params.name as string, s.headers["mcp-name"] as string]));
    expect(sent.get("plain_name")).toBe("plain_name");
    for (const name of names.slice(0, 3)) {
      const header = sent.get(name)!;
      expect(header, name).toMatch(/^=\?base64\?[A-Za-z0-9+/=]+\?=$/);
      expect(decodeSentinel(header)).toBe(name);
    }
    // A resource URI with non-ASCII characters is encoded the same way.
    const uri = "skill://café/SKILL.md";
    const p2 = await fakePanel((body) => ok(body, { contents: [] }));
    await runRelay(dir, p2.port, [modern(1, "resources/read", { uri })]);
    expect(decodeSentinel(p2.seen[0].headers["mcp-name"] as string)).toBe(uri);
  });

  it("never asks for elicitation on a modern call, even after a legacy initialize that declared it", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ok(body, {}));
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "1" } } };
    await runRelay(dir, panel.port, [init, modern(2, "tools/call", { name: "ae_status", arguments: {} }), callStatus(3)]);
    const byMethod = (id: number) => panel.seen.find((s) => s.body.id === id)!;
    expect(byMethod(2).headers["x-chroma-elicitation"]).toBeUndefined();
    expect(byMethod(2).headers["mcp-protocol-version"]).toBe("2026-07-28");
    // The legacy call keeps its header and gets no modern ones.
    expect(byMethod(3).headers["x-chroma-elicitation"]).toBe("1");
    expect(byMethod(3).headers["mcp-protocol-version"]).toBeUndefined();
    expect(byMethod(3).headers["mcp-method"]).toBeUndefined();
  });

  it("a client that probes with server/discover and then falls back to initialize is still observed at the initialize", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ok(body, {}));
    const stderr: string[] = [];
    const init = { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "fallback-client", version: "1" } } };
    await runRelay(dir, panel.port, [modern(1, "server/discover"), init, callStatus(3)], { stderr });
    const call = panel.seen.find((s) => s.body.id === 3)!;
    expect(call.headers["x-chroma-elicitation"]).toBe("1");
    expect(call.headers["x-chroma-client"]).toBe("fallback-client");
    // The toolset line is still written once.
    expect(stderr.filter((l) => /\btoolset (core|full) \(/.test(l))).toHaveLength(1);
  });

  it("a request with a legacy version in _meta is sent as a legacy one", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ok(body, {}));
    await runRelay(dir, panel.port, [modern(1, "tools/list", {}, { [PV]: "2025-06-18" })]);
    expect(panel.seen[0].headers["mcp-protocol-version"]).toBeUndefined();
    expect(panel.seen[0].headers["mcp-method"]).toBeUndefined();
  });

  it("takes X-Chroma-Client from the request's _meta clientInfo, and logs the toolset choice once", async () => {
    const { dir } = home();
    const panel = await fakePanel((body) => ok(body, {}));
    const stderr: string[] = [];
    await runRelay(
      dir,
      panel.port,
      [
        modern(1, "tools/list", {}, mmeta({ [CINFO]: { name: "Some Client\r\nX-Evil: 1", version: "2" } })),
        modern(2, "tools/list", {}, mmeta({ [CINFO]: { name: "other", version: "2" } })),
        modern(3, "tools/list", {}, mmeta({ [CINFO]: { version: "2" } })),
      ],
      { stderr }
    );
    const clientOf = (id: number) => panel.seen.find((s) => s.body.id === id)!.client;
    expect(clientOf(1)).toBe("Some Client X-Evil: 1");
    expect(clientOf(2)).toBe("other");
    expect(clientOf(3)).toMatch(/^(Some Client X-Evil: 1|other)$/); // no name of its own: the one the relay knows
    const lines = stderr.filter((l) => l.includes("toolset ") && l.includes("client "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("toolset core (default core); client ");
  });

  it("passes the panel's 400 and 404 JSON-RPC error bodies through unchanged", async () => {
    const { dir } = home();
    const bad = { code: -32022, message: "Unsupported protocol version", data: { supported: ALL_VERSIONS, requested: "2099-01-01" } };
    const missing = { code: -32601, message: "Method not found: ping" };
    const panel = await fakePanel((body) =>
      body.method === "ping"
        ? { status: 404, body: { jsonrpc: "2.0", id: body.id, error: missing } }
        : { status: 400, body: { jsonrpc: "2.0", id: body.id, error: bad } }
    );
    const replies = await runRelay(dir, panel.port, [modern(1, "tools/list", {}, mmeta({ [PV]: "2099-01-01" })), modern(2, "ping")]);
    expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 1, error: bad });
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, error: missing });
  });

  it("caches a modern list reply like a legacy one, and the instructions from server/discover", async () => {
    const { dir, dataDir } = home();
    const panel = await fakePanel((body) => {
      if (body.method === "tools/list") return ok(body, { tools: [TOOLS[0], { name: "ae_search_tools", description: "s", inputSchema: { type: "object" } }], resultType: "complete" });
      if (body.method === "server/discover") return ok(body, { supportedVersions: ALL_VERSIONS, instructions: "MODERN CORE INSTRUCTIONS", resultType: "complete" });
      return ok(body, {});
    });
    await runRelay(dir, panel.port, [modern(1, "tools/list"), modern(2, "server/discover")]);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "relay-tools-core-cache.json"), "utf8")).tools).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "relay-instructions-core-cache.json"), "utf8"))).toEqual({ instructions: "MODERN CORE INSTRUCTIONS" });
    // A full-toolset discover keeps no instructions.
    const { dir: dir2, dataDir: data2 } = home();
    await runRelay(dir2, panel.port, [modern(1, "server/discover")], { toolset: "full" });
    expect(fs.existsSync(path.join(data2, "relay-instructions-core-cache.json"))).toBe(false);
  });

  describe("while AE is closed", () => {
    const offline = (dir: string, messages: unknown[], opts: Parameters<typeof runRelay>[3] = {}) => closedPort().then((port) => runRelay(dir, port, messages, opts));
    const expectModern = (r: any, scope?: "private" | "public") => {
      expect(r.result.resultType).toBe("complete");
      expect(r.result._meta[SINFO].name).toBe("chroma-ae-mcp");
      expect(r.result._meta[SINFO].version).toMatch(/^\d+\.\d+\.\d+/);
      if (scope) {
        expect(r.result.ttlMs).toBe(0);
        expect(r.result.cacheScope).toBe(scope);
      }
    };

    it("answers server/discover itself, with the instructions from the cache for core", async () => {
      const { dir, dataDir } = home();
      const bare = await offline(dir, [modern(1, "server/discover")]);
      expectModern(bare[0], "private");
      expect(bare[0].result.supportedVersions).toEqual(ALL_VERSIONS);
      expect(bare[0].result.capabilities).toEqual({
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        extensions: { "io.modelcontextprotocol/skills": {} },
      });
      expect(bare[0].result).not.toHaveProperty("instructions");
      fs.writeFileSync(path.join(dataDir, "relay-instructions-core-cache.json"), JSON.stringify({ instructions: "CACHED" }));
      const core = await offline(dir, [modern(1, "server/discover")], { toolset: "core" });
      expect(core[0].result.instructions).toBe("CACHED");
      const full = await offline(dir, [modern(1, "server/discover")], { toolset: "full" });
      expect(full[0].result).not.toHaveProperty("instructions");
    });

    it("answers the lists in the modern shape, from caches a modern reply and a legacy reply wrote", async () => {
      const { dir } = home();
      const panel = await fakePanel((body) => {
        const modernReq = body.params && body.params._meta;
        const extra = modernReq ? { resultType: "complete", ttlMs: 300000, cacheScope: "public" } : {};
        if (body.method === "tools/list") return ok(body, { tools: CORE_LIST, ...extra });
        if (body.method === "prompts/list") return ok(body, { prompts: [{ name: "motion_review" }], ...extra });
        if (body.method === "resources/list") return ok(body, { resources: [{ uri: "chroma-ae://guidance/a.md", name: "a" }], ...extra });
        return ok(body, {});
      });
      const CORE_LIST = [{ name: "ae_search_tools", description: "s", inputSchema: { type: "object" } }];
      // tools and resources from modern replies; prompts from a legacy one.
      await runRelay(dir, panel.port, [modern(1, "tools/list"), { jsonrpc: "2.0", id: 2, method: "prompts/list" }, modern(3, "resources/list")]);
      const r = await offline(dir, [modern(1, "tools/list"), modern(2, "prompts/list"), modern(3, "resources/list"), modern(4, "resources/templates/list")]);
      expectModern(r[0], "private");
      expect(r[0].result.tools).toEqual(CORE_LIST);
      expectModern(r[1], "public");
      expect(r[1].result.prompts).toEqual([{ name: "motion_review" }]);
      expectModern(r[2], "public");
      expect(r[2].result.resources).toEqual([{ uri: "chroma-ae://guidance/a.md", name: "a" }]);
      expectModern(r[3], "public");
      expect(r[3].result.resourceTemplates).toEqual([]);
    });

    it("keeps the modern resources list apart from the legacy one", async () => {
      const { dir, dataDir } = home();
      const LEGACY = [{ uri: "chroma-ae://guidance/a.md", name: "a" }];
      const MODERN = [{ uri: SKILL_URI, name: "captions" }];
      const panel = await fakePanel((body) => {
        if (body.method === "resources/list") return ok(body, { resources: body.params && body.params._meta ? MODERN : LEGACY });
        return ok(body, {});
      });
      await runRelay(dir, panel.port, [{ jsonrpc: "2.0", id: 1, method: "resources/list" }]);
      const legacyFile = path.join(dataDir, "relay-resources-cache.json");
      const before = fs.readFileSync(legacyFile, "utf8");
      expect(JSON.parse(before)).toEqual({ resources: LEGACY });
      await runRelay(dir, panel.port, [modern(1, "resources/list")]);
      expect(fs.readFileSync(legacyFile, "utf8")).toBe(before);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, "relay-resources-modern-cache.json"), "utf8"))).toEqual({ resources: MODERN });
      const r = await offline(dir, [modern(1, "resources/list"), { jsonrpc: "2.0", id: 2, method: "resources/list" }]);
      expect(r[0].result.resources).toEqual(MODERN);
      expect(r[1].result).toEqual({ resources: LEGACY });
    });

    it("has the same fallbacks as legacy: empty prompts and resources, the full tool list for core, -32603 for no tools", async () => {
      const { dir, dataDir } = home();
      const none = await offline(dir, [modern(1, "tools/list"), modern(2, "prompts/list"), modern(3, "resources/list"), modern(4, "skills/list")]);
      expect(none[0].error.code).toBe(-32603);
      expect(none[0].error.message).toMatch(/not reachable/);
      expect(none[1].result.prompts).toEqual([]);
      expect(none[2].result.resources).toEqual([]);
      expectModern(none[3], "public");
      expect(none[3].result.skills).toEqual([]);
      fs.writeFileSync(path.join(dataDir, "relay-tools-cache.json"), JSON.stringify({ tools: TOOLS }));
      const core = await offline(dir, [modern(1, "tools/list")], { toolset: "core" });
      expect(core[0].result.tools).toEqual(TOOLS);
    });

    it("answers a tool call as an isError text in the modern shape", async () => {
      const { dir } = home();
      const r = await offline(dir, [modern(1, "tools/call", { name: "ae_status", arguments: {} })]);
      expectModern(r[0]);
      expect(r[0].result.isError).toBe(true);
      expect(r[0].result.content[0].text).toMatch(/Start After Effects/);
      expect(r[0].result).not.toHaveProperty("ttlMs");
    });

    it("serves resources/read and prompts/get from the guidance text the panel served, and -32602 when not found", async () => {
      const { dir } = home();
      const ctx = {} as ToolContext;
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
      await runRelay(dir, (server.address() as AddressInfo).port, [{ jsonrpc: "2.0", id: 1, method: "prompts/list" }]);

      const skill = "chroma-ae://guidance/motion-director/SKILL.md";
      const r = await offline(dir, [
        modern(1, "resources/read", { uri: skill }),
        modern(2, "prompts/get", { name: "motion_director" }),
        modern(3, "prompts/get", { name: "motion_director", arguments: { task: "  a 6 s logo sting " } }),
        modern(4, "resources/read", { uri: "chroma-ae://guidance/nope.md" }),
        modern(5, "prompts/get", { name: "nope" }),
      ]);
      const legacy = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: skill } }, ctx)) as any;
      expectModern(r[0], "public");
      expect(r[0].result.contents).toEqual(legacy.result.contents);
      const plain = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "motion_director" } }, ctx)) as any;
      expectModern(r[1]);
      expect(r[1].result.messages).toEqual(plain.result.messages);
      expect(r[2].result.messages[0].content.text).toContain("a 6 s logo sting");
      expect(r[3].error).toMatchObject({ code: -32602, data: { uri: "chroma-ae://guidance/nope.md" } });
      expect(r[4].error.code).toBe(-32602);
    });

    it("says -32603 with the reason for resources/read and prompts/get when no guidance was ever cached", async () => {
      const { dir } = home();
      const r = await offline(dir, [modern(1, "resources/read", { uri: "x" }), modern(2, "prompts/get", { name: "x" })]);
      for (const reply of r) {
        expect(reply.error.code).toBe(-32603);
        expect(reply.error.message).toMatch(/not reachable/);
      }
    });

    it("answers skills/list, skills/get and a skill file's resources/read from the cache the panel filled", async () => {
      const { dir, dataDir } = home();
      const panel = await fakePanel((body) => {
        if (body.method === "skills/list") return ok(body, { skills: SKILLS, resultType: "complete" });
        if (body.method === "resources/read") return ok(body, { contents: skillContents(body.params.uri), resultType: "complete" });
        return ok(body, {});
      });
      const online = await runRelay(dir, panel.port, [modern(1, "skills/list")]);
      expect(online[0].result.skills).toEqual(SKILLS);
      // The relay read each listed file as a modern request of its own.
      const reads = panel.seen.filter((s) => s.body.method === "resources/read");
      expect(reads.map((s) => s.body.params.uri).sort()).toEqual([SKILL_URI, SKILL_REF].sort());
      for (const s of reads) {
        expect(s.body.params._meta).toMatchObject({ [PV]: "2026-07-28", [CAPS]: {}, [CINFO]: { name: "chroma-ae-relay" } });
        expect(s.headers["mcp-protocol-version"]).toBe("2026-07-28");
        expect(s.headers["mcp-method"]).toBe("resources/read");
        expect(s.headers["mcp-name"]).toBe(s.body.params.uri);
        expect(s.headers["x-chroma-client"]).toBe("chroma-ae-relay");
      }
      expect(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      // A skills prefetch alone leaves no guidance contents cache; the files live in the skills cache.
      expect(fs.existsSync(path.join(dataDir, "relay-contents-cache.json"))).toBe(false);
      expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, "relay-skills-cache.json"), "utf8")).files).sort()).toEqual([SKILL_URI, SKILL_REF].sort());
      // A legacy offline resources/read of a skill:// URI stays -32002 (and there is no guidance cache: -32000).
      const legacy = await offline(dir, [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: SKILL_URI } }]);
      expect(legacy[0].error.code).toBe(-32000);

      const r = await offline(dir, [
        modern(1, "skills/list"),
        modern(2, "skills/get", { uri: SKILL_URI }),
        modern(3, "resources/read", { uri: SKILL_REF }),
        modern(4, "skills/get", { uri: "skill://nope/SKILL.md" }),
        modern(5, "skills/get", {}),
        modern(6, "resources/read", { uri: "skill://captions/missing.md" }),
      ]);
      expectModern(r[0], "public");
      expect(r[0].result.skills).toEqual(SKILLS);
      expectModern(r[1], "public");
      expect(r[1].result.skill).toEqual(SKILLS[0]);
      expectModern(r[2], "public");
      expect(r[2].result.contents).toEqual(skillContents(SKILL_REF));
      expect(r[3].error).toMatchObject({ code: -32602, message: "No skill is served at skill://nope/SKILL.md" });
      expect(r[4].error.code).toBe(-32602);
      expect(r[5].error).toMatchObject({ code: -32602, data: { uri: "skill://captions/missing.md" } });
    });

    it("answers skills/get with -32603 when no skills cache exists", async () => {
      const { dir } = home();
      const r = await offline(dir, [modern(1, "skills/get", { uri: SKILL_URI })]);
      expect(r[0].error.code).toBe(-32603);
      expect(r[0].error.message).toMatch(/not reachable/);
    });

    it("keeps the guidance and the skill files both, whichever prefetch runs first", async () => {
      const { dir } = home();
      const GUIDE = "chroma-ae://guidance/a.md";
      const panel = await fakePanel((body) => {
        const isModern = !!(body.params && body.params._meta);
        if (body.method === "skills/list") return ok(body, { skills: SKILLS });
        if (body.method === "resources/list") return ok(body, { resources: [{ uri: GUIDE, name: "a" }] });
        if (body.method === "prompts/list") return ok(body, { prompts: [] });
        if (body.method === "resources/read") {
          return ok(body, { contents: isModern ? skillContents(body.params.uri) : [{ uri: GUIDE, mimeType: "text/markdown", text: "guide" }] });
        }
        return ok(body, {});
      });
      await runRelay(dir, panel.port, [{ jsonrpc: "2.0", id: 1, method: "resources/list" }, modern(2, "skills/list"), { jsonrpc: "2.0", id: 3, method: "prompts/list" }]);
      const r = await offline(dir, [modern(1, "resources/read", { uri: GUIDE }), modern(2, "resources/read", { uri: SKILL_URI }), modern(3, "resources/read", { uri: SKILL_REF })]);
      expect(r[0].result.contents[0].text).toBe("guide");
      expect(r[1].result.contents).toEqual(skillContents(SKILL_URI));
      expect(r[2].result.contents).toEqual(skillContents(SKILL_REF));
      const legacyRead = await offline(dir, [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: SKILL_URI } }]);
      expect(legacyRead[0].error.code).toBe(-32002);
      // A second run's guidance prefetch rewrites the contents cache and leaves the skill files.
      await runRelay(dir, panel.port, [{ jsonrpc: "2.0", id: 1, method: "resources/list" }]);
      const again = await offline(dir, [modern(1, "resources/read", { uri: SKILL_REF }), modern(2, "resources/read", { uri: GUIDE })]);
      expect(again[0].result.contents).toEqual(skillContents(SKILL_REF));
      expect(again[1].result.contents[0].text).toBe("guide");
    });

    it("a failing skills prefetch (an older panel) leaves the guidance cache alone and caches no skills", async () => {
      const { dir, dataDir } = home();
      const panel = await fakePanel((body) => {
        const isModern = !!(body.params && body.params._meta);
        if (body.method === "skills/list") return ok(body, { skills: SKILLS });
        if (body.method === "resources/list") return ok(body, { resources: [{ uri: "chroma-ae://guidance/a.md" }] });
        if (body.method === "prompts/list") return ok(body, { prompts: [] });
        if (body.method === "resources/read" && isModern) return { status: 400, body: { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "nope" } } };
        if (body.method === "resources/read") return ok(body, { contents: [{ uri: "chroma-ae://guidance/a.md", text: "guide" }] });
        return ok(body, {});
      });
      const stderr: string[] = [];
      const online = await runRelay(dir, panel.port, [modern(1, "skills/list"), { jsonrpc: "2.0", id: 2, method: "resources/list" }, { jsonrpc: "2.0", id: 3, method: "prompts/list" }], { stderr });
      expect(online[0].result.skills).toEqual(SKILLS);
      expect(stderr.some((l) => l.includes("could not fetch the skills"))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, "relay-skills-cache.json"))).toBe(false);
      const guide = JSON.parse(fs.readFileSync(path.join(dataDir, "relay-contents-cache.json"), "utf8"));
      expect(Object.keys(guide.resources)).toEqual(["chroma-ae://guidance/a.md"]);
    });

    it("mirrors the panel's validation: unsupported version, missing capabilities, missing _meta version", async () => {
      const { dir } = home();
      const r = await offline(dir, [
        modern(1, "tools/list", {}, mmeta({ [PV]: "2099-01-01" })),
        modern(2, "tools/list", {}, { [PV]: "2026-07-28" }),
        modern(3, "tools/list", {}, mmeta({ [PV]: 5 })),
        { jsonrpc: "2.0", id: 4, method: "server/discover" },
        { jsonrpc: "2.0", id: 5, method: "skills/list", params: {} },
        { jsonrpc: "2.0", id: 6, method: "skills/get", params: { uri: SKILL_URI, _meta: {} } },
        modern(7, "tools/list", {}, { [PV]: "2026-07-28", [CAPS]: [] }),
      ]);
      expect(r[0].error).toEqual({ code: -32022, message: "Unsupported protocol version", data: { supported: ALL_VERSIONS, requested: "2099-01-01" } });
      expect(r[1].error.code).toBe(-32602);
      expect(r[1].error.message).toContain(CAPS);
      expect(r[2].error).toMatchObject({ code: -32022, data: { requested: 5 } });
      for (const i of [3, 4, 5]) {
        expect(r[i].error.code, String(i)).toBe(-32602);
        expect(r[i].error.data).toEqual({ supported: ALL_VERSIONS });
        expect(r[i].error.message).toContain(PV);
      }
      expect(r[6].error.code).toBe(-32602);
    });

    it("treats a legacy version string in _meta as legacy, answered exactly as without it", async () => {
      const { dir, dataDir } = home();
      fs.writeFileSync(path.join(dataDir, "relay-tools-cache.json"), JSON.stringify({ tools: TOOLS }));
      const r = await offline(dir, [modern(1, "tools/list", {}, { [PV]: "2025-06-18" }), modern(2, "resources/list", {}, { [PV]: "2025-03-26" })], { toolset: "full" });
      expect(r[0].result).toEqual({ tools: TOOLS });
      expect(r[1].result).toEqual({ resources: [] });
    });

    it("answers any other modern method with -32601, and notifications with nothing", async () => {
      const { dir } = home();
      const r = await offline(dir, [
        modern(1, "ping"),
        modern(2, "initialize", { protocolVersion: "2025-06-18" }),
        modern(3, "subscriptions/listen"),
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { _meta: mmeta() } },
      ]);
      expect(r).toHaveLength(3);
      for (const reply of r) expect(reply.error.code).toBe(-32601);
      expect(r[0].error.message).toBe("Method not found: ping");
    });
  });
});
