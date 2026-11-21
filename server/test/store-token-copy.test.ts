import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const COMMON = path.resolve(__dirname, "../../panel/client/common.js");
const RELAY = path.resolve(__dirname, "../../panel/tools/stdio-relay.cjs");
const DIAG = path.resolve(__dirname, "../../panel/tools/relay-diagnose.cjs");
const common = require(COMMON) as {
  findPackagedTokenCopies: (base: string, opts?: Record<string, unknown>) => { package: string; path: string }[];
  syncPackagedTokenCopies: (
    base: string,
    token: string,
    onLog?: (level: string, msg: string) => void,
    opts?: Record<string, unknown>
  ) => { package: string; path: string }[];
};
const diag = require(DIAG) as {
  decide: (f: any) => { code: string; ok: boolean; message: string; fix: string[]; facts_summary: string[] };
  gather: (o?: Record<string, unknown>) => Promise<any>;
  resetCache: () => void;
};

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const WIN = process.platform === "win32";
const FAMILY = "Claude_test123";

const tmpDirs: string[] = [];
const servers: http.Server[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-store-copy-"));
  tmpDirs.push(d);
  return d;
}
beforeEach(() => diag.resetCache());
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function copyDir(base: string, family = FAMILY) {
  return path.join(base, "Packages", family, "LocalCache", "Local", "chroma-ae-mcp");
}
function makeCopy(base: string, token: string, family = FAMILY): string {
  const dir = copyDir(base, family);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "token");
  fs.writeFileSync(p, token + "\n");
  return p;
}

describe("common.js packaged token copies", () => {
  it("lists nothing off win32", () => {
    const base = tmp();
    makeCopy(base, OLD);
    expect(common.findPackagedTokenCopies(base, { platform: "darwin" })).toEqual([]);
    expect(common.syncPackagedTokenCopies(base, NEW, undefined, { platform: "linux" })).toEqual([]);
    expect(fs.readFileSync(path.join(copyDir(base), "token"), "utf8").trim()).toBe(OLD);
  });

  it("lists only existing token files in package folders", () => {
    const base = tmp();
    const p = makeCopy(base, OLD);
    fs.mkdirSync(copyDir(base, "Other_x"), { recursive: true }); // folder without a token
    fs.mkdirSync(path.join(copyDir(base, "Dir_y"), "token"), { recursive: true }); // token is a folder
    fs.writeFileSync(path.join(base, "Packages", "stray-file"), "x"); // not a directory
    expect(common.findPackagedTokenCopies(base, { platform: "win32" })).toEqual([{ package: FAMILY, path: p }]);
  });

  it("returns [] when Packages is missing or the base is empty", () => {
    expect(common.findPackagedTokenCopies(tmp(), { platform: "win32" })).toEqual([]);
    expect(common.findPackagedTokenCopies("", { platform: "win32" })).toEqual([]);
  });

  it("updates only a differing copy and never creates one", () => {
    const base = tmp();
    const stale = makeCopy(base, OLD);
    const same = makeCopy(base, NEW, "Same_z");
    fs.mkdirSync(path.join(base, "Packages", "Empty_e"), { recursive: true });
    const mtimeSame = fs.statSync(same).mtimeMs;
    const logs: string[] = [];
    const updated = common.syncPackagedTokenCopies(base, NEW, (l, m) => logs.push(l + m), { platform: "win32" });
    expect(updated).toEqual([{ package: FAMILY, path: stale }]);
    expect(fs.readFileSync(stale, "utf8")).toBe(NEW);
    expect(fs.statSync(same).mtimeMs).toBe(mtimeSame);
    expect(fs.existsSync(path.join(base, "Packages", "Empty_e", "LocalCache"))).toBe(false);
    expect(logs).toEqual([]);
    // A second run finds nothing to do.
    expect(common.syncPackagedTokenCopies(base, NEW, undefined, { platform: "win32" })).toEqual([]);
  });

  it("ignores a token that is not a valid token", () => {
    const base = tmp();
    const stale = makeCopy(base, OLD);
    expect(common.syncPackagedTokenCopies(base, "", undefined, { platform: "win32" })).toEqual([]);
    expect(fs.readFileSync(stale, "utf8").trim()).toBe(OLD);
  });

  it("survives an unreadable or unwritable copy and reports it as a warning", () => {
    const base = tmp();
    const bad = makeCopy(base, OLD, "Bad_a");
    const good = makeCopy(base, OLD, "Good_b");
    const realFs = fs;
    const fake = {
      ...realFs,
      readFileSync: (p: string, enc: string) => {
        if (p === bad) throw new Error("EACCES: read");
        return realFs.readFileSync(p, enc as BufferEncoding);
      },
    };
    const logs: [string, string][] = [];
    const updated = common.syncPackagedTokenCopies(base, NEW, (l, m) => logs.push([l, m]), { platform: "win32", fs: fake });
    expect(updated.map((u) => u.package)).toEqual(["Good_b"]);
    expect(fs.readFileSync(good, "utf8")).toBe(NEW);
    expect(logs.length).toBe(1);
    expect(logs[0][0]).toBe("warn");
    expect(logs[0][1]).toContain(bad);

    const failingWrite = {
      ...realFs,
      writeFileSync: () => {
        throw new Error("EPERM: write");
      },
    };
    const logs2: [string, string][] = [];
    expect(common.syncPackagedTokenCopies(base, NEW, (l, m) => logs2.push([l, m]), { platform: "win32", fs: failingWrite })).toEqual([]);
    expect(logs2.length).toBeGreaterThan(0);
    // A throwing logger does not escape either.
    expect(() =>
      common.syncPackagedTokenCopies(
        base,
        "c".repeat(64),
        () => {
          throw new Error("x");
        },
        { platform: "win32", fs: failingWrite }
      )
    ).not.toThrow();
  });
});

// ---------- the relay's 401 path ----------

function relayHome(token: string) {
  const dir = tmp();
  const dataDir = path.join(dir, "chroma-ae-mcp");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "token"), token + "\n");
  return { dir, tokenFile: path.join(dataDir, "token") };
}

async function panel(reply: (auth: string | undefined, count: number) => { status: number; body?: unknown }) {
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req.headers.authorization);
      const out = reply(req.headers.authorization, seen.length);
      res.statusCode = out.status;
      res.setHeader("Content-Type", "application/json");
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, seen };
}

async function runRelay(homeDir: string, port: number): Promise<any[]> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  const drop = ["LOCALAPPDATA", "APPDATA", "HOME", "USERPROFILE", "CHROMA_AE_MCP_PORT", "CHROMA_AE_MCP_TOOLSET", "CHROMA_AE_MCP_DIAGNOSE"];
  for (const k of Object.keys(baseEnv)) {
    if (drop.includes(k.toUpperCase())) delete baseEnv[k];
  }
  const child = childProcess.spawn(process.execPath, [RELAY], {
    env: {
      ...baseEnv,
      CHROMA_AE_MCP_DIAGNOSE: "off",
      CHROMA_AE_MCP_STORE_COPY_WAIT_MS: "50",
      LOCALAPPDATA: homeDir,
      APPDATA: homeDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CHROMA_AE_MCP_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ae_status", arguments: {} } }) + "\n");
  await new Promise((r) => child.on("close", r));
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const AUTH_ERR = { ok: false, error: { kind: "auth" } };
const OK_REPLY = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "fine" }] } };

describe("stdio-relay.cjs 401 handling", { timeout: 20000 }, () => {
  it.runIf(WIN)("retries once after the service fixes the packaged copy, then succeeds", async () => {
    const { dir, tokenFile } = relayHome(OLD);
    makeCopy(dir, OLD);
    const p = await panel((auth) => {
      if (auth === "Bearer " + NEW) return { status: 200, body: OK_REPLY };
      // The service rejects the request and rewrites the token the relay reads.
      fs.writeFileSync(tokenFile, NEW + "\n");
      return { status: 401, body: AUTH_ERR };
    });
    const replies = await runRelay(dir, p.port);
    expect(replies[0].result.content[0].text).toBe("fine");
    expect(p.seen).toEqual(["Bearer " + OLD, "Bearer " + NEW]);
  });

  it.runIf(WIN)("names the Store copy when it stays stale, and does not retry an unchanged token", async () => {
    const { dir, tokenFile } = relayHome(OLD);
    const copy = makeCopy(dir, OLD);
    const p = await panel(() => ({ status: 401, body: AUTH_ERR }));
    const replies = await runRelay(dir, p.port);
    const text = replies[0].result.content[0].text as string;
    expect(replies[0].result.isError).toBe(true);
    expect(text).toContain("Claude Desktop (Microsoft Store build) reads its own copy of the token at " + copy);
    expect(text).toContain("not the file After Effects writes (" + tokenFile + ")");
    expect(text).toContain("rename the folder " + path.dirname(copy) + " to chroma-ae-mcp.old");
    expect(text).toContain("Don't remove chroma-ae from claude_desktop_config.json");
    expect(text).not.toContain(OLD);
    expect(p.seen.length).toBe(1);
  });

  it.runIf(WIN)("retries once at most when the token changed but is still rejected", async () => {
    const { dir, tokenFile } = relayHome(OLD);
    makeCopy(dir, OLD);
    const p = await panel(() => {
      fs.writeFileSync(tokenFile, NEW + "\n");
      return { status: 401, body: AUTH_ERR };
    });
    const replies = await runRelay(dir, p.port);
    expect(replies[0].result.content[0].text).toContain("Microsoft Store build");
    expect(p.seen.length).toBe(2);
  });

  it("gives the generic message and does not retry when there is no packaged copy", async () => {
    const { dir, tokenFile } = relayHome(OLD);
    const p = await panel(() => ({ status: 401, body: AUTH_ERR }));
    const replies = await runRelay(dir, p.port);
    const text = replies[0].result.content[0].text as string;
    expect(replies[0].result.isError).toBe(true);
    expect(text).toContain("rejected the token in " + tokenFile);
    expect(text).toContain("Another After Effects, or an old Chroma service, may hold the port with a different token.");
    expect(text).toContain("make sure no AfterFX.exe is left in Task Manager");
    expect(text).toContain("relay-diagnose.cjs");
    expect(text).not.toContain("Restart After Effects.");
    expect(p.seen.length).toBe(1);
  });
});

// ---------- relay-diagnose ----------

function baseFacts(over: Record<string, unknown> = {}) {
  return {
    now: 1_000_000_000,
    platform: "win32",
    port: 7790,
    quick: false,
    state_dir: "C:\\data\\chroma-ae-mcp",
    token: { present: true, valid: true },
    owner: { present: false },
    health: { status: 401, error: null, json: true, chroma: false, auth_error: true, instance: null },
    processes: { interactive: [], engines: [] },
    installed: [],
    panel: { installed: true, dir: "C:\\ext", version: "0.6.0" },
    debug_mode: null,
    port_holder: null,
    probes_failed: [],
    ...over,
  };
}

describe("relay-diagnose store_app_token_copy", () => {
  const copyPath = "C:\\u\\AppData\\Local\\Packages\\Claude_x\\LocalCache\\Local\\chroma-ae-mcp\\token";

  it("is reported when a packaged copy differs and the service rejects the token", () => {
    const res = diag.decide(baseFacts({ packaged_copies: [{ package: "Claude_x", path: copyPath, mtime: "2026-11-01T10:00:00.000Z", matches: false }] }));
    expect(res.code).toBe("store_app_token_copy");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Claude Desktop (Microsoft Store build) reads its own copy of the token at " + copyPath);
    expect(res.fix[0]).toContain("to chroma-ae-mcp.old, then reopen Claude Desktop.");
    expect(res.fix[0]).toContain("Don't remove chroma-ae from claude_desktop_config.json");
    expect(res.facts_summary.join("\n")).toContain("differs from the real file");
  });

  it("is only a note when the copy matches", () => {
    const res = diag.decide(baseFacts({ packaged_copies: [{ package: "Claude_x", path: copyPath, mtime: "2026-11-01T10:00:00.000Z", matches: true }] }));
    expect(res.code).toBe("token_rejected");
    const summary = res.facts_summary.join("\n");
    expect(summary).toContain("Claude_x");
    expect(summary).toContain("2026-11-01T10:00:00.000Z");
    expect(summary).toContain("same token as the real file");
  });

  it("does not change the result without copies", () => {
    expect(diag.decide(baseFacts({ packaged_copies: [] })).code).toBe("token_rejected");
    expect(diag.decide(baseFacts()).code).toBe("token_rejected");
  });

  it.runIf(WIN)("gather compares copy and real token without keeping any token text", async () => {
    const dir = tmp();
    const dataDir = path.join(dir, "chroma-ae-mcp");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "token"), NEW);
    makeCopy(dir, OLD, "Claude_x");
    makeCopy(dir, NEW, "Other_y");
    const facts = await diag.gather({
      port: 1,
      dataDir,
      quick: true,
      env: { LOCALAPPDATA: dir },
      httpGet: async () => ({ status: 401, text: JSON.stringify(AUTH_ERR) }),
    });
    const byPkg = Object.fromEntries(facts.packaged_copies.map((c: any) => [c.package, c.matches]));
    expect(byPkg).toEqual({ Claude_x: false, Other_y: true });
    expect(JSON.stringify(facts)).not.toContain(OLD);
    expect(JSON.stringify(facts)).not.toContain(NEW);
    const res = diag.decide(facts);
    expect(res.code).toBe("store_app_token_copy");
    expect(res.message).not.toContain(OLD);
  });
});
