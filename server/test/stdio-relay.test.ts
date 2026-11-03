import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
      seen.push({ auth: req.headers.authorization, body });
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

async function runRelay(homeDir: string, port: number, messages: unknown[]): Promise<any[]> {
  const child = childProcess.spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      LOCALAPPDATA: homeDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CHROMA_AE_MCP_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const code = await new Promise((r) => child.on("close", r));
  expect(code).toBe(0);
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
    fs.writeFileSync(path.join(dataDir, "relay-tools-cache.json"), JSON.stringify({ tools: TOOLS }));

    const replies = await runRelay(dir, await closedPort(), [
      initialize(1, "2025-03-26"),
      listTools(2),
      callStatus(3),
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
    ]);

    expect(replies[0].result.protocolVersion).toBe("2025-03-26");
    expect(replies[0].result.serverInfo.name).toBe("chroma-ae-mcp");
    expect(replies[1].result.tools).toEqual(TOOLS);
    expect(replies[2].result.isError).toBe(true);
    expect(replies[2].result.content[0].text).toMatch(/Start After Effects/);
    expect(replies[3].error.message).toMatch(/not reachable/);
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
});
